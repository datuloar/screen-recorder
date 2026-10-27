import Foundation
import ScreenCaptureKit
import AVFoundation
import CoreGraphics
import VideoToolbox

public typealias Callback = @convention(c) (UnsafeMutableRawPointer?, Int32, UnsafePointer<CChar>?) -> Void

final class Recording: NSObject, SCStreamOutput, SCStreamDelegate, AVCaptureAudioDataOutputSampleBufferDelegate {
    let queue = DispatchQueue(label: "recorder.capture", qos: .userInitiated)
    let context: UnsafeMutableRawPointer?
    let callback: Callback
    var stream: SCStream?
    var writer: AVAssetWriter?
    var input: AVAssetWriterInput?
    var adaptor: AVAssetWriterInputPixelBufferAdaptor?
    var timeline = CaptureTimeline()
    var latest: CVPixelBuffer?
    var timer: DispatchSourceTimer?
    var frames: Int64 = 0
    var fps: Int32 = 30
    var audio: [String: AudioFileWriter] = [:]
    var microphone: AVCaptureSession?
    var microphoneObserver: NSObjectProtocol?
    var preparing = true
    var stopReason: String?
    var stopping = false
    var finishing = false
    var terminal = false

    init(context: UnsafeMutableRawPointer?, callback: @escaping Callback) {
        self.context = context
        self.callback = callback
    }

    deinit {
        if let observer = microphoneObserver { NotificationCenter.default.removeObserver(observer) }
        timer?.cancel()
    }

    func notify(_ kind: Int32, _ message: String) { message.withCString { callback(context, kind, $0) } }

    var now: Double { CMClockGetTime(CMClockGetHostTimeClock()).seconds }

    func complete(_ error: String? = nil) {
        guard !terminal else { return }
        terminal = true
        if let error = error { error.withCString { callback(context, -1, $0) } }
        else { callback(context, 0, nil) }
    }

    func start(displayID: UInt32, rect: CGRect, fps: UInt32, bitrate: UInt32, cursor: Bool, path: String, audioSettings: [String: Any]) {
        Task {
            do {
                let micEnabled = audioSettings["microphone"] as? Bool ?? false
                if micEnabled {
                    let permitted = await AVCaptureDevice.requestAccess(for: .audio)
                    guard permitted else { throw recordingError("Allow microphone access in System Settings > Privacy & Security > Microphone") }
                }
                let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
                guard let display = content.displays.first(where: {$0.displayID == displayID}) else {
                    throw NSError(domain: "Recorder", code: 1, userInfo: [NSLocalizedDescriptionKey: "The selected display was disconnected"])
                }
                let excluded = content.applications.filter { $0.processID == ProcessInfo.processInfo.processIdentifier }
                let filter = SCContentFilter(display: display, excludingApplications: excluded, exceptingWindows: [])
                let config = SCStreamConfiguration()
                let scale = CGFloat(display.width) / display.frame.width
                config.sourceRect = CGRect(x: rect.origin.x / scale, y: rect.origin.y / scale,
                    width: rect.width / scale, height: rect.height / scale)
                config.width = Int(rect.width)
                config.height = Int(rect.height)
                config.minimumFrameInterval = CMTime(value: 1, timescale: Int32(fps))
                config.queueDepth = 3
                config.showsCursor = cursor
                config.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
                config.colorSpaceName = CGColorSpace.itur_709
                config.capturesAudio = audioSettings["system"] as? Bool ?? false
                config.excludesCurrentProcessAudio = true
                config.sampleRate = 48_000
                config.channelCount = 2
                let writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .mp4)
                writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
                let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
                    AVVideoCodecKey: AVVideoCodecType.h264,
                    AVVideoWidthKey: config.width,
                    AVVideoHeightKey: config.height,
                    AVVideoEncoderSpecificationKey: [kVTVideoEncoderSpecification_RequireHardwareAcceleratedVideoEncoder as String: true],
                    AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate,
                        AVVideoExpectedSourceFrameRateKey: fps, AVVideoMaxKeyFrameIntervalKey: fps * 2]
                ])
                input.expectsMediaDataInRealTime = true
                guard writer.canAdd(input) else { throw NSError(domain: "Recorder", code: 2, userInfo: [NSLocalizedDescriptionKey: "Hardware H.264 encoding is unavailable"] ) }
                writer.add(input)
                let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: nil)
                let stream = SCStream(filter: filter, configuration: config, delegate: self)
                try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                    self.queue.async {
                        do {
                            self.writer = writer; self.input = input; self.adaptor = adaptor; self.stream = stream
                            self.fps = Int32(fps)
                            for role in ["system", "microphone"] where audioSettings[role] as? Bool == true {
                                let url = URL(fileURLWithPath: path).deletingPathExtension().appendingPathExtension("\(role).m4a")
                                self.audio[role] = try AudioFileWriter(path: url.path)
                            }
                            try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: self.queue)
                            if config.capturesAudio { try stream.addStreamOutput(self, type: .audio, sampleHandlerQueue: self.queue) }
                            if micEnabled { try self.prepareMicrophone(id: audioSettings["microphone_device"] as? String) }
                            guard writer.startWriting() else { throw writer.error ?? recordingError("Could not open the video file") }
                            writer.startSession(atSourceTime: .zero)
                            let timer = DispatchSource.makeTimerSource(queue: self.queue)
                            timer.schedule(deadline: .now(), repeating: .milliseconds(5), leeway: .milliseconds(1))
                            timer.setEventHandler { [weak self] in self?.tick() }
                            self.timer = timer; timer.resume()
                            continuation.resume()
                        } catch { continuation.resume(throwing: error) }
                    }
                }
                microphone?.startRunning()
                try await stream.startCapture()
                queue.async { self.preparing = false; if self.stopping { self.stop() } }
            } catch { queue.async { self.preparing = false; self.stop(error: error.localizedDescription) } }
        }
    }

    func prepareMicrophone(id: String?) throws {
        let device: AVCaptureDevice?
        if let id = id, !id.isEmpty { device = AVCaptureDevice.devices(for: .audio).first { $0.uniqueID == id } }
        else { device = AVCaptureDevice.default(for: .audio) }
        guard let device = device else { throw recordingError("The selected microphone is unavailable") }
        let session = AVCaptureSession()
        let input = try AVCaptureDeviceInput(device: device)
        let output = AVCaptureAudioDataOutput()
        guard session.canAddInput(input), session.canAddOutput(output) else { throw recordingError("Could not open the microphone") }
        session.addInput(input); session.addOutput(output)
        output.setSampleBufferDelegate(self, queue: queue)
        microphone = session
        microphoneObserver = NotificationCenter.default.addObserver(forName: .AVCaptureSessionRuntimeError, object: session, queue: nil) { [weak self] _ in
            self?.queue.async { self?.notify(10, "Microphone disconnected. The track continues with silence.") }
        }
    }

    func consumeAudio(_ sample: CMSampleBuffer, role: String) {
        guard !stopping, !terminal, timeline.base != nil, let track = audio[role] else { return }
        do {
            let pcm = try track.decode(sample)
            let slices = timeline.slices(start: sample.presentationTimeStamp.seconds, frames: pcm.count / 4)
            let peak: Int = pcm.withUnsafeBytes { bytes in
                stride(from: 0, to: bytes.count, by: 2).reduce(0) { max($0, abs(Int(bytes.loadUnaligned(fromByteOffset: $1, as: Int16.self)))) }
            }
            notify(role == "system" ? 2 : 3, String(slices.isEmpty ? 0 : min(100, peak * 100 / 32768)))
            for slice in slices {
                try track.write(at: slice.position, pcm: pcm.subdata(in: slice.offset * 4..<(slice.offset + slice.frames) * 4))
            }
        } catch { stop(error: error.localizedDescription) }
    }

    func captureOutput(_ output: AVCaptureOutput, didOutput sampleBuffer: CMSampleBuffer, from connection: AVCaptureConnection) {
        consumeAudio(sampleBuffer, role: "microphone")
    }

    func tick() {
        guard !terminal, !stopping, timeline.pausedAt == nil, timeline.base != nil, let buffer = latest, let input = input else { return }
        let elapsed = timeline.elapsed(at: now)
        let target = Int64((elapsed * Double(fps)).rounded(.up))
        if target - frames > 3 { notify(4, String(target - frames - 3)); frames = target - 3 }
        do {
            while frames < target && input.isReadyForMoreMediaData {
                guard adaptor?.append(buffer, withPresentationTime: CMTime(value: frames, timescale: fps)) == true else {
                    throw writer?.error ?? recordingError("Could not write the video frame")
                }
                frames += 1; callback(context, 1, nil)
            }
            for track in audio.values { try track.pad(to: Int64(max(0, elapsed - 0.2) * 48_000)) }
        } catch { stop(error: error.localizedDescription) }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of outputType: SCStreamOutputType) {
        if outputType == .audio { consumeAudio(sample, role: "system"); return }
        guard outputType == .screen, !terminal, !stopping, timeline.pausedAt == nil,
            let buffer = sample.imageBuffer else { return }
        if let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
            let raw = attachments.first?[.status] as? Int, raw != SCFrameStatus.complete.rawValue { return }
        if timeline.base == nil { timeline.base = sample.presentationTimeStamp.seconds }
        latest = buffer
        tick()
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        queue.async { self.stop(error: error.localizedDescription) }
    }

    func setPaused(_ paused: Bool) {
        queue.async {
            self.timeline.setPaused(paused, at: self.now)
        }
    }

    func stop(error: String? = nil) {
        queue.async {
            guard !self.terminal, !self.finishing else { return }
            self.stopping = true
            if let error = error { self.stopReason = error }
            guard !self.preparing else { return }
            self.finishing = true
            self.timeline.setPaused(true, at: self.now)
            self.timer?.cancel(); self.timer = nil
            Task {
                self.microphone?.stopRunning()
                try? await self.stream?.stopCapture()
                self.queue.async {
                    let duration = self.timeline.elapsed(at: self.now)
                    let group = DispatchGroup()
                    var errors = [self.stopReason].compactMap { $0 }
                    for track in self.audio.values {
                        group.enter()
                        track.finish(duration: duration) { error in
                            self.queue.async { if let error = error { errors.append(error) }; group.leave() }
                        }
                    }
                    self.input?.markAsFinished()
                    if let writer = self.writer, writer.status == .writing {
                        writer.endSession(atSourceTime: CMTime(value: self.frames, timescale: self.fps))
                        group.enter()
                        writer.finishWriting {
                            self.queue.async { if let error = writer.error { errors.append(error.localizedDescription) }; group.leave() }
                        }
                    }
                    group.notify(queue: self.queue) { self.complete(errors.isEmpty ? nil : errors.joined(separator: "\n")) }
                }
            }
        }
    }
}

@_cdecl("sr_displays")
public func displays() -> UnsafeMutablePointer<CChar>? {
    var ids = [CGDirectDisplayID](repeating: 0, count: 32)
    var count: UInt32 = 0
    guard CGGetActiveDisplayList(32, &ids, &count) == .success else { return nil }
    let values: [[String: Any]] = ids.prefix(Int(count)).map { id in
        let bounds = CGDisplayBounds(id)
        let width = CGDisplayPixelsWide(id)
        let height = CGDisplayPixelsHigh(id)
        return ["id": id, "name": "Display \(id)", "width": width, "height": height,
            "x": Int(bounds.origin.x), "y": Int(bounds.origin.y), "scale": Double(width) / bounds.width]
    }
    guard let data = try? JSONSerialization.data(withJSONObject: values), let text = String(data: data, encoding: .utf8) else { return nil }
    return strdup(text)
}

@_cdecl("sr_free_string")
public func freeString(_ value: UnsafeMutablePointer<CChar>?) { free(value) }

@_cdecl("sr_audio_devices")
public func audioDevices(_ microphone: Bool) -> UnsafeMutablePointer<CChar>? {
    var values = [["id": "", "name": microphone ? "System default device" : "Audio from all applications"]]
    if microphone { values += AVCaptureDevice.devices(for: .audio).map { ["id": $0.uniqueID, "name": $0.localizedName] } }
    guard let data = try? JSONSerialization.data(withJSONObject: values), let text = String(data: data, encoding: .utf8) else { return nil }
    return strdup(text)
}

@_cdecl("sr_create")
public func create(_ display: UInt32, _ x: UInt32, _ y: UInt32, _ width: UInt32, _ height: UInt32,
    _ fps: UInt32, _ bitrate: UInt32, _ cursor: Bool, _ path: UnsafePointer<CChar>, _ audio: UnsafePointer<CChar>,
    _ context: UnsafeMutableRawPointer?, _ callback: @escaping Callback) -> UnsafeMutableRawPointer {
    let recording = Recording(context: context, callback: callback)
    let settings = (try? JSONSerialization.jsonObject(with: Data(String(cString: audio).utf8))) as? [String: Any] ?? [:]
    recording.start(displayID: display, rect: CGRect(x: Int(x), y: Int(y), width: Int(width), height: Int(height)),
        fps: fps, bitrate: bitrate, cursor: cursor, path: String(cString: path), audioSettings: settings)
    return Unmanaged.passRetained(recording).toOpaque()
}

@_cdecl("sr_pause")
public func pause(_ pointer: UnsafeMutableRawPointer, _ paused: Bool) { Unmanaged<Recording>.fromOpaque(pointer).takeUnretainedValue().setPaused(paused) }

@_cdecl("sr_stop")
public func stop(_ pointer: UnsafeMutableRawPointer) { Unmanaged<Recording>.fromOpaque(pointer).takeUnretainedValue().stop() }

@_cdecl("sr_destroy")
public func destroy(_ pointer: UnsafeMutableRawPointer) { Unmanaged<Recording>.fromOpaque(pointer).release() }
