use crate::RecordingStats;
use anyhow::{Context, bail};
use recorder_core::{AudioDeviceInfo, AudioRole, RecordingConfig, place_samples};
use std::{
    path::Path,
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
        mpsc,
    },
    thread::JoinHandle,
    time::Duration,
};
use windows::{
    Win32::{
        Foundation::{CloseHandle, HANDLE, WAIT_FAILED},
        Media::{Audio::*, MediaFoundation::*},
        System::{
            Com::*,
            Threading::{CreateEventW, WaitForSingleObject},
        },
    },
    core::{HSTRING, PCWSTR},
};

const RATE: u32 = 48_000;
const BLOCK: usize = 4;

struct Apartment;
impl Apartment {
    fn new() -> anyhow::Result<Self> {
        unsafe {
            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
        }
        Ok(Self)
    }
}
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe {
            CoUninitialize();
        }
    }
}

struct Event(HANDLE);
impl Drop for Event {
    fn drop(&mut self) {
        let _ = unsafe { CloseHandle(self.0) };
    }
}

struct Variant(windows::Win32::System::Com::StructuredStorage::PROPVARIANT);
impl Drop for Variant {
    fn drop(&mut self) {
        let _ = unsafe {
            windows::Win32::System::Com::StructuredStorage::PropVariantClear(&mut self.0)
        };
    }
}

struct Capture {
    client: IAudioClient,
    capture: IAudioCaptureClient,
    event: Event,
}
impl Drop for Capture {
    fn drop(&mut self) {
        let _ = unsafe { self.client.Stop() };
    }
}

fn device(
    enumerator: &IMMDeviceEnumerator,
    role: AudioRole,
    id: Option<&str>,
) -> anyhow::Result<IMMDevice> {
    unsafe {
        Ok(if let Some(id) = id.filter(|id| !id.is_empty()) {
            enumerator.GetDevice(&HSTRING::from(id))?
        } else {
            enumerator.GetDefaultAudioEndpoint(
                if role == AudioRole::System {
                    eRender
                } else {
                    eCapture
                },
                eConsole,
            )?
        })
    }
}

pub fn audio_devices(role: AudioRole) -> anyhow::Result<Vec<AudioDeviceInfo>> {
    let apartment = Apartment::new()?;
    let mut result = vec![AudioDeviceInfo {
        id: String::new(),
        name: "System default device".into(),
    }];
    unsafe {
        let enumerator: IMMDeviceEnumerator =
            CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
        let devices = enumerator.EnumAudioEndpoints(
            if role == AudioRole::System {
                eRender
            } else {
                eCapture
            },
            DEVICE_STATE_ACTIVE,
        )?;
        for index in 0..devices.GetCount()? {
            let device = devices.Item(index)?;
            let id = device.GetId()?;
            let id_text = id.to_string();
            CoTaskMemFree(Some(id.0.cast()));
            let id = id_text?;
            let store = device.OpenPropertyStore(STGM_READ)?;
            let property =
                Variant(store.GetValue(
                    &windows::Win32::Devices::FunctionDiscovery::PKEY_Device_FriendlyName,
                )?);
            let name = windows::Win32::System::Com::StructuredStorage::PropVariantToStringAlloc(
                &property.0,
            )?;
            let name_text = name.to_string();
            CoTaskMemFree(Some(name.0.cast()));
            result.push(AudioDeviceInfo {
                id,
                name: name_text?,
            });
        }
    }
    drop(apartment);
    Ok(result)
}

impl Capture {
    fn open(role: AudioRole, id: Option<&str>) -> anyhow::Result<Self> {
        unsafe {
            let enumerator: IMMDeviceEnumerator =
                CoCreateInstance(&MMDeviceEnumerator, None, CLSCTX_ALL)?;
            let device = device(&enumerator, role, id)?;
            let client: IAudioClient = device.Activate(CLSCTX_ALL, None)?;
            let format = WAVEFORMATEX {
                wFormatTag: 1,
                nChannels: 2,
                nSamplesPerSec: RATE,
                nAvgBytesPerSec: RATE * BLOCK as u32,
                nBlockAlign: BLOCK as u16,
                wBitsPerSample: 16,
                cbSize: 0,
            };
            let flags = AUDCLNT_STREAMFLAGS_EVENTCALLBACK
                | AUDCLNT_STREAMFLAGS_AUTOCONVERTPCM
                | AUDCLNT_STREAMFLAGS_SRC_DEFAULT_QUALITY
                | if role == AudioRole::System {
                    AUDCLNT_STREAMFLAGS_LOOPBACK
                } else {
                    0
                };
            client.Initialize(AUDCLNT_SHAREMODE_SHARED, flags, 1_000_000, 0, &format, None)?;
            let event = Event(CreateEventW(None, false, false, PCWSTR::null())?);
            client.SetEventHandle(event.0)?;
            let capture = client.GetService()?;
            client.Start()?;
            Ok(Self {
                client,
                capture,
                event,
            })
        }
    }

    fn read(
        &self,
        stats: &RecordingStats,
        writer: &mut TrackWriter,
        role: AudioRole,
    ) -> anyhow::Result<()> {
        unsafe {
            while self.capture.GetNextPacketSize()? > 0 {
                let mut data = std::ptr::null_mut();
                let mut frames = 0;
                let mut flags = 0;
                let mut qpc = 0;
                self.capture
                    .GetBuffer(&mut data, &mut frames, &mut flags, None, Some(&mut qpc))?;
                let result = (|| {
                    if frames == 0 || !stats.ready.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    if flags & AUDCLNT_BUFFERFLAGS_TIMESTAMP_ERROR.0 as u32 != 0 {
                        bail!("Audio device returned an invalid timestamp");
                    }
                    let bytes = frames as usize * BLOCK;
                    // WASAPI permits a null data pointer when the SILENT flag is set.
                    let silence;
                    let pcm = if flags & AUDCLNT_BUFFERFLAGS_SILENT.0 as u32 != 0 {
                        silence = vec![0; bytes];
                        silence.as_slice()
                    } else {
                        anyhow::ensure!(!data.is_null(), "Audio buffer is empty");
                        std::slice::from_raw_parts(data, bytes)
                    };
                    let captured = super::instant_from_qpc(qpc)?;
                    let slices = stats
                        .clock
                        .lock()
                        .unwrap()
                        .capture_slices(captured, frames, RATE);
                    let peak = pcm
                        .chunks_exact(2)
                        .map(|s| i16::from_le_bytes([s[0], s[1]]).unsigned_abs() as u32)
                        .max()
                        .unwrap_or(0)
                        * 100
                        / 32768;
                    let meter = if role == AudioRole::System {
                        &stats.system_level
                    } else {
                        &stats.microphone_level
                    };
                    meter.store(if slices.is_empty() { 0 } else { peak }, Ordering::Relaxed);
                    for slice in slices {
                        let first = slice.offset_frames as usize * BLOCK;
                        let last = first + slice.frames as usize * BLOCK;
                        writer.write_at(slice.position, &pcm[first..last])?;
                    }
                    Ok::<_, anyhow::Error>(())
                })();
                self.capture.ReleaseBuffer(frames)?;
                result?;
            }
        }
        Ok(())
    }
}

struct TrackWriter {
    writer: IMFSinkWriter,
    stream: u32,
    next_frame: u64,
}

impl TrackWriter {
    fn new(path: &Path) -> anyhow::Result<Self> {
        super::initialize_media_foundation()?;
        unsafe {
            let mut attrs = None;
            MFCreateAttributes(&mut attrs, 2)?;
            let attrs = attrs.context("Could not create audio file attributes")?;
            attrs.SetGUID(
                &MF_TRANSCODE_CONTAINERTYPE,
                &MFTranscodeContainerType_FMPEG4,
            )?;
            attrs.SetUINT64(&MF_MPEG4SINK_MIN_FRAGMENT_DURATION, 20_000_000)?;
            let writer = MFCreateSinkWriterFromURL(&HSTRING::from(path.as_os_str()), None, &attrs)?;
            let output = MFCreateMediaType()?;
            output.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            output.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_AAC)?;
            output.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            output.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
            output.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            output.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, 24_000)?;
            let stream = writer.AddStream(&output)?;
            let input = MFCreateMediaType()?;
            input.SetGUID(&MF_MT_MAJOR_TYPE, &MFMediaType_Audio)?;
            input.SetGUID(&MF_MT_SUBTYPE, &MFAudioFormat_PCM)?;
            input.SetUINT32(&MF_MT_AUDIO_NUM_CHANNELS, 2)?;
            input.SetUINT32(&MF_MT_AUDIO_SAMPLES_PER_SECOND, RATE)?;
            input.SetUINT32(&MF_MT_AUDIO_BITS_PER_SAMPLE, 16)?;
            input.SetUINT32(&MF_MT_AUDIO_BLOCK_ALIGNMENT, BLOCK as u32)?;
            input.SetUINT32(&MF_MT_AUDIO_AVG_BYTES_PER_SECOND, RATE * BLOCK as u32)?;
            input.SetUINT32(&MF_MT_ALL_SAMPLES_INDEPENDENT, 1)?;
            writer.SetInputMediaType(stream, &input, None)?;
            writer.BeginWriting()?;
            Ok(Self {
                writer,
                stream,
                next_frame: 0,
            })
        }
    }

    fn write(&mut self, pcm: &[u8]) -> anyhow::Result<()> {
        if pcm.is_empty() {
            return Ok(());
        }
        anyhow::ensure!(pcm.len().is_multiple_of(BLOCK), "Invalid PCM block");
        unsafe {
            let buffer = MFCreateMemoryBuffer(pcm.len() as u32)?;
            let mut data = std::ptr::null_mut();
            buffer.Lock(&mut data, None, None)?;
            std::ptr::copy_nonoverlapping(pcm.as_ptr(), data, pcm.len());
            buffer.Unlock()?;
            buffer.SetCurrentLength(pcm.len() as u32)?;
            let sample = MFCreateSample()?;
            sample.AddBuffer(&buffer)?;
            let frames = pcm.len() / BLOCK;
            let start = self.next_frame as u128 * 10_000_000 / RATE as u128;
            let end = (self.next_frame as u128 + frames as u128) * 10_000_000 / RATE as u128;
            sample.SetSampleTime(start as i64)?;
            sample.SetSampleDuration((end - start) as i64)?;
            self.writer.WriteSample(self.stream, &sample)?;
            self.next_frame += frames as u64;
        }
        Ok(())
    }

    fn pad_to(&mut self, frame: u64) -> anyhow::Result<()> {
        let zero = [0u8; 480 * BLOCK];
        while self.next_frame < frame {
            let count = (frame - self.next_frame).min(480) as usize;
            self.write(&zero[..count * BLOCK])?;
        }
        Ok(())
    }

    fn write_at(&mut self, time: Duration, pcm: &[u8]) -> anyhow::Result<()> {
        let start = (time.as_nanos() * RATE as u128 + 500_000_000) / 1_000_000_000;
        let placement = place_samples(self.next_frame, start as u64, (pcm.len() / BLOCK) as u64);
        self.pad_to(self.next_frame + placement.gap_frames)?;
        self.write(&pcm[placement.skip_frames as usize * BLOCK..])
    }

    fn finish(self) -> anyhow::Result<()> {
        unsafe {
            self.writer.Finalize()?;
        }
        Ok(())
    }
}

pub struct AudioGroup {
    stop: Arc<AtomicBool>,
    workers: Vec<JoinHandle<Result<(), String>>>,
}

impl AudioGroup {
    pub fn start(config: &RecordingConfig, stats: &RecordingStats) -> anyhow::Result<Self> {
        let mut group = Self {
            stop: Arc::new(AtomicBool::new(false)),
            workers: Vec::new(),
        };
        for role in config.audio.enabled() {
            let stop = group.stop.clone();
            let stats = stats.clone();
            let id = config.audio.device(role).map(str::to_owned);
            let path = role.asset_path(&config.output);
            let (ready_tx, ready_rx) = mpsc::sync_channel(1);
            group.workers.push(std::thread::spawn(move || {
                let result = (|| {
                    let _apartment = Apartment::new()?;
                    let capture = Capture::open(role, id.as_deref())
                        .with_context(|| format!("Could not enable {}", role.label()))?;
                    let mut writer = TrackWriter::new(&path)?;
                    let _ = ready_tx.send(Ok(()));
                    let mut capture = Some(capture);
                    let loop_result = (|| {
                        while !stop.load(Ordering::Acquire) {
                            if let Some(stream) = &capture {
                                if unsafe { WaitForSingleObject(stream.event.0, 50) } == WAIT_FAILED
                                {
                                    bail!("Waiting for the audio device failed");
                                }
                                if let Err(error) = stream.read(&stats, &mut writer, role) {
                                    *stats.audio_warning.lock().unwrap() = Some(format!(
                                        "{} disconnected: {error:#}. The track continues with silence.",
                                        role.label()
                                    ));
                                    capture = None;
                                }
                            } else {
                                std::thread::sleep(Duration::from_millis(20));
                            }
                            if stats.ready.load(Ordering::Acquire)
                                && !stats.paused.load(Ordering::Acquire)
                            {
                                let elapsed = stats
                                    .clock
                                    .lock()
                                    .unwrap()
                                    .elapsed()
                                    .saturating_sub(Duration::from_millis(200));
                                writer.pad_to(
                                    (elapsed.as_nanos() * RATE as u128 / 1_000_000_000) as u64,
                                )?;
                            }
                        }
                        if stats.ready.load(Ordering::Acquire) {
                            if let Some(stream) = &capture {
                                let _ = stream.read(&stats, &mut writer, role);
                            }
                            let elapsed = stats.clock.lock().unwrap().elapsed();
                            writer.pad_to(
                                (elapsed.as_nanos() * RATE as u128 / 1_000_000_000) as u64,
                            )?;
                        }
                        Ok::<_, anyhow::Error>(())
                    })();
                    let close = writer.finish();
                    loop_result.and(close)
                })()
                .map_err(|e| format!("{e:#}"));
                if let Err(error) = &result {
                    let _ = ready_tx.try_send(Err(error.clone()));
                    *stats.audio_failure.lock().unwrap() = Some(error.clone());
                }
                result
            }));
            match ready_rx.recv_timeout(Duration::from_secs(5)) {
                Ok(Ok(())) => {}
                Ok(Err(e)) => bail!("{e}"),
                Err(_) => bail!("Audio device did not respond within five seconds"),
            }
        }
        Ok(group)
    }

    pub fn finish(mut self) -> anyhow::Result<()> {
        self.stop.store(true, Ordering::Release);
        let mut errors = Vec::new();
        for worker in self.workers.drain(..) {
            match worker.join() {
                Ok(Ok(())) => {}
                Ok(Err(e)) => errors.push(e),
                Err(_) => errors.push("Audio thread terminated unexpectedly".into()),
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            bail!("{}", errors.join("; "))
        }
    }
}

impl Drop for AudioGroup {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
    }
}
