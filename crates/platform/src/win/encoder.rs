use anyhow::Context;
use recorder_core::RecordingConfig;
use windows::{
    Win32::{
        Graphics::{Direct3D11::*, Dxgi::Common::*},
        Media::MediaFoundation::*,
    },
    core::{HSTRING, Interface},
};
use windows_capture::frame::Frame;

pub struct Encoder {
    writer: IMFSinkWriter,
    stream: u32,
    config: RecordingConfig,
    processor: ID3D11VideoProcessor,
    enumerator: ID3D11VideoProcessorEnumerator,
    pub name: String,
    latest: Option<IMFMediaBuffer>,
    next_frame: u64,
}

// Sink Writer is used only from MTA threads, with all calls serialized by the capture handler.
unsafe impl Send for Encoder {}

impl Encoder {
    pub fn new(config: &RecordingConfig, device: &ID3D11Device) -> anyhow::Result<Self> {
        // The capture library initializes COM on its dedicated capture thread.
        unsafe {
            super::initialize_media_foundation()?;
            let mut attributes = None;
            MFCreateAttributes(&mut attributes, 4)?;
            let attributes = attributes.context("MF attributes unavailable")?;
            attributes.SetUINT32(&MF_READWRITE_ENABLE_HARDWARE_TRANSFORMS, 1)?;
            attributes.SetGUID(
                &MF_TRANSCODE_CONTAINERTYPE,
                &MFTranscodeContainerType_FMPEG4,
            )?;
            attributes.SetUINT64(&MF_MPEG4SINK_MIN_FRAGMENT_DURATION, 20_000_000)?;
            let mut token = 0;
            let mut manager = None;
            MFCreateDXGIDeviceManager(&mut token, &mut manager)?;
            let manager = manager.context("D3D manager unavailable")?;
            manager.ResetDevice(device, token)?;
            attributes.SetUnknown(&MF_SINK_WRITER_D3D_MANAGER, &manager)?;
            let output = HSTRING::from(config.output.as_os_str());
            let writer = MFCreateSinkWriterFromURL(&output, None, &attributes)?;
            let video = MFCreateMediaType()?;
            set_geometry(&video, config)?;
            video.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_H264)?;
            video.SetUINT32(&MF_MT_AVG_BITRATE, config.bitrate)?;
            let stream = writer.AddStream(&video)?;
            let input = MFCreateMediaType()?;
            set_geometry(&input, config)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFVideoFormat_NV12)?;
            writer.SetInputMediaType(stream, &input, None)?;
            writer.BeginWriting()?;
            let mut codec = std::ptr::null_mut();
            writer
                .GetServiceForStream(
                    stream,
                    &windows::core::GUID::zeroed(),
                    &ICodecAPI::IID,
                    &mut codec,
                )
                .context("Hardware encoder controls are unavailable")?;
            let codec = ICodecAPI::from_raw(codec);
            codec
                .SetValue(
                    &CODECAPI_AVEncCommonRateControlMode,
                    &windows::Win32::System::Variant::VARIANT::from(
                        eAVEncCommonRateControlMode_UnconstrainedVBR.0 as u32,
                    ),
                )
                .context("The encoder does not support the requested bitrate mode")?;
            codec
                .SetValue(
                    &CODECAPI_AVEncCommonMeanBitRate,
                    &windows::Win32::System::Variant::VARIANT::from(config.bitrate),
                )
                .context("The encoder rejected the selected bitrate")?;
            let extended: IMFSinkWriterEx = writer.cast()?;
            let mut hardware_name = None;
            for index in 0..16 {
                let mut category = windows::core::GUID::zeroed();
                let mut transform = None;
                if extended
                    .GetTransformForStream(stream, index, Some(&mut category), &mut transform)
                    .is_err()
                {
                    break;
                }
                if category != MFT_CATEGORY_VIDEO_ENCODER {
                    continue;
                }
                let Some(transform) = transform else {
                    continue;
                };
                let attributes = transform.GetAttributes()?;
                if attributes
                    .GetStringLength(&MFT_ENUM_HARDWARE_URL_Attribute)
                    .is_ok()
                {
                    let mut buffer = [0u16; 256];
                    let name = if attributes
                        .GetString(&MFT_FRIENDLY_NAME_Attribute, &mut buffer, None)
                        .is_ok()
                    {
                        let length = buffer.iter().position(|c| *c == 0).unwrap_or(buffer.len());
                        String::from_utf16_lossy(&buffer[..length])
                    } else {
                        "Media Foundation hardware H.264".into()
                    };
                    hardware_name = Some(name);
                    break;
                }
            }
            let name=hardware_name.context("A hardware H.264 encoder could not be confirmed. Update your GPU driver or use another computer.")?;
            let video_device: ID3D11VideoDevice = device.cast()?;
            let context = device.GetImmediateContext()?;
            let multithread: windows::Win32::Graphics::Direct3D10::ID3D10Multithread =
                context.cast()?;
            let _ = multithread.SetMultithreadProtected(true);
            let rate = DXGI_RATIONAL {
                Numerator: config.fps,
                Denominator: 1,
            };
            let content = D3D11_VIDEO_PROCESSOR_CONTENT_DESC {
                InputFrameFormat: D3D11_VIDEO_FRAME_FORMAT_PROGRESSIVE,
                InputFrameRate: rate,
                InputWidth: config.display.width,
                InputHeight: config.display.height,
                OutputFrameRate: rate,
                OutputWidth: config.region.width,
                OutputHeight: config.region.height,
                Usage: D3D11_VIDEO_USAGE_PLAYBACK_NORMAL,
            };
            let enumerator = video_device.CreateVideoProcessorEnumerator(&content)?;
            let processor = video_device.CreateVideoProcessor(&enumerator, 0)?;
            Ok(Self {
                writer,
                stream,
                config: config.clone(),
                processor,
                enumerator,
                name,
                latest: None,
                next_frame: 0,
            })
        }
    }

    pub fn update(&mut self, frame: &Frame<'_>) -> anyhow::Result<()> {
        let r = self.config.region;
        r.validate(frame.width(), frame.height())
            .map_err(anyhow::Error::msg)?;
        // Own the cropped surface: WGC is allowed to recycle its source after this callback.
        unsafe {
            let description = D3D11_TEXTURE2D_DESC {
                Width: r.width,
                Height: r.height,
                MipLevels: 1,
                ArraySize: 1,
                Format: DXGI_FORMAT_NV12,
                SampleDesc: DXGI_SAMPLE_DESC {
                    Count: 1,
                    Quality: 0,
                },
                Usage: D3D11_USAGE_DEFAULT,
                BindFlags: D3D11_BIND_RENDER_TARGET.0 as u32,
                ..Default::default()
            };
            let mut texture = None;
            frame
                .device()
                .CreateTexture2D(&description, None, Some(&mut texture))?;
            let texture = texture.context("GPU surface unavailable")?;
            let video_device: ID3D11VideoDevice = frame.device().cast()?;
            let context: ID3D11VideoContext = frame.device_context().cast()?;
            let mut input_view = None;
            video_device.CreateVideoProcessorInputView(
                frame.as_raw_texture(),
                &self.enumerator,
                &D3D11_VIDEO_PROCESSOR_INPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPIV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut input_view),
            )?;
            let mut output_view = None;
            video_device.CreateVideoProcessorOutputView(
                &texture,
                &self.enumerator,
                &D3D11_VIDEO_PROCESSOR_OUTPUT_VIEW_DESC {
                    ViewDimension: D3D11_VPOV_DIMENSION_TEXTURE2D,
                    ..Default::default()
                },
                Some(&mut output_view),
            )?;
            let source = windows::Win32::Foundation::RECT {
                left: r.x as i32,
                top: r.y as i32,
                right: (r.x + r.width) as i32,
                bottom: (r.y + r.height) as i32,
            };
            let dest = windows::Win32::Foundation::RECT {
                left: 0,
                top: 0,
                right: r.width as i32,
                bottom: r.height as i32,
            };
            context.VideoProcessorSetStreamSourceRect(&self.processor, 0, true, Some(&source));
            context.VideoProcessorSetStreamDestRect(&self.processor, 0, true, Some(&dest));
            let mut stream = D3D11_VIDEO_PROCESSOR_STREAM {
                Enable: true.into(),
                pInputSurface: std::mem::ManuallyDrop::new(input_view),
                ..Default::default()
            };
            let blit = context.VideoProcessorBlt(
                &self.processor,
                output_view.as_ref().context("Output view unavailable")?,
                0,
                std::slice::from_ref(&stream),
            );
            std::mem::ManuallyDrop::drop(&mut stream.pInputSurface);
            blit.context("GPU conversion from BGRA to NV12")?;
            let buffer = MFCreateDXGISurfaceBuffer(&ID3D11Texture2D::IID, &texture, 0, false)
                .context("Creating a DXGI buffer")?;
            buffer
                .SetCurrentLength(r.width * r.height * 3 / 2)
                .context("Setting the NV12 buffer length")?;
            self.latest = Some(buffer);
        }
        Ok(())
    }

    pub fn tick(&mut self, time: std::time::Duration) -> anyhow::Result<(u64, u64)> {
        let Some(buffer) = &self.latest else {
            return Ok((0, 0));
        };
        let target = (time.as_nanos() * self.config.fps as u128 / 1_000_000_000) as u64;
        let mut count = 0;
        // Bound catch-up work after a driver stall; timestamps retain the real elapsed time.
        let dropped = target.saturating_sub(2).saturating_sub(self.next_frame);
        self.next_frame = self.next_frame.max(target.saturating_sub(2));
        while self.next_frame <= target {
            unsafe {
                let sample = MFCreateSample()?;
                sample.AddBuffer(buffer)?;
                sample.SetSampleTime(
                    (self.next_frame as u128 * 10_000_000 / self.config.fps as u128) as i64,
                )?;
                sample.SetSampleDuration(10_000_000 / self.config.fps as i64)?;
                self.writer
                    .WriteSample(self.stream, &sample)
                    .context("Submitting a frame to the encoder")?;
            }
            self.next_frame += 1;
            count += 1;
        }
        Ok((count, dropped))
    }

    pub fn finish(self) -> anyhow::Result<()> {
        unsafe {
            self.writer.Finalize().context("Finalizing MP4")?;
        }
        Ok(())
    }
}

unsafe fn set_geometry(
    media: &IMFMediaType,
    config: &RecordingConfig,
) -> windows::core::Result<()> {
    unsafe {
        media.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Video)?;
        media.SetUINT32(&MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive.0 as u32)?;
        media.SetUINT64(
            &MF_MT_FRAME_SIZE,
            ((config.region.width as u64) << 32) | config.region.height as u64,
        )?;
        media.SetUINT64(&MF_MT_FRAME_RATE, ((config.fps as u64) << 32) | 1)?;
        media.SetUINT64(&MF_MT_PIXEL_ASPECT_RATIO, (1u64 << 32) | 1)?;
        Ok(())
    }
}
