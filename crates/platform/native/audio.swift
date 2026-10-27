import Foundation
import AVFoundation
import CoreMedia

func recordingError(_ message: String) -> NSError {
    NSError(domain: "ScreenRecorder", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

struct CaptureTimeline {
    var base: Double?
    var pausedAt: Double?
    var pauses: [(Double, Double)] = []

    mutating func setPaused(_ paused: Bool, at now: Double) {
        if paused && pausedAt == nil { pausedAt = now }
        else if !paused, let start = pausedAt { pauses.append((start, now)); pausedAt = nil }
    }

    func elapsed(at now: Double) -> Double {
        guard let base = base else { return 0 }
        let end = pausedAt ?? now
        let excluded = pauses.reduce(0.0) { $0 + max(0, min($1.1, end) - max($1.0, base)) }
        return max(0, end - base - excluded)
    }

    func slices(start: Double, frames: Int) -> [(offset: Int, frames: Int, position: Double)] {
        guard let base = base else { return [] }
        let end = start + Double(frames) / 48_000
        var cursor = max(start, base)
        var spans: [(Double, Double)] = []
        for (a, b) in pauses {
            if b <= cursor { continue }
            if a >= end { break }
            if a > cursor { spans.append((cursor, min(a, end))) }
            cursor = max(cursor, b)
        }
        let activeEnd = min(end, pausedAt ?? end)
        if cursor < activeEnd { spans.append((cursor, activeEnd)) }
        return spans.compactMap { a, b in
            let first = min(frames, max(0, Int(ceil((a - start) * 48_000))))
            let last = min(frames, max(0, Int(ceil((b - start) * 48_000))))
            let time = start + Double(first) / 48_000
            let excluded = pauses.reduce(0.0) { $0 + ($1.1 <= time ? max(0, $1.1 - max($1.0, base)) : 0) }
            return last > first ? (first, last - first, max(0, time - base - excluded)) : nil
        }
    }
}

final class AudioFileWriter {
    let writer: AVAssetWriter
    let input: AVAssetWriterInput
    let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 48_000, channels: 2, interleaved: true)!
    let description: CMAudioFormatDescription
    var converter: AVAudioConverter?
    var nextFrame: Int64 = 0

    init(path: String) throws {
        writer = try AVAssetWriter(outputURL: URL(fileURLWithPath: path), fileType: .m4a)
        writer.movieFragmentInterval = CMTime(seconds: 2, preferredTimescale: 600)
        input = AVAssetWriterInput(mediaType: .audio, outputSettings: [
            AVFormatIDKey: kAudioFormatMPEG4AAC, AVSampleRateKey: 48_000,
            AVNumberOfChannelsKey: 2, AVEncoderBitRateKey: 192_000
        ])
        input.expectsMediaDataInRealTime = true
        var desc: CMAudioFormatDescription?
        let status = CMAudioFormatDescriptionCreate(allocator: kCFAllocatorDefault, asbd: format.streamDescription,
            layoutSize: 0, layout: nil, magicCookieSize: 0, magicCookie: nil, extensions: nil, formatDescriptionOut: &desc)
        guard status == noErr, let desc = desc else { throw recordingError("Could not create the PCM format") }
        description = desc
        guard writer.canAdd(input) else { throw recordingError("AAC encoding is unavailable") }
        writer.add(input)
        guard writer.startWriting() else { throw writer.error ?? recordingError("Could not open the audio file") }
        writer.startSession(atSourceTime: .zero)
    }

    func decode(_ sample: CMSampleBuffer) throws -> Data {
        guard let description = sample.formatDescription else { throw recordingError("Audio format is missing") }
        let sourceFormat = AVAudioFormat(cmAudioFormatDescription: description)
        let count = sample.numSamples
        guard count > 0, let source = AVAudioPCMBuffer(pcmFormat: sourceFormat, frameCapacity: AVAudioFrameCount(count)) else { return Data() }
        source.frameLength = AVAudioFrameCount(count)
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sample, at: 0, frameCount: Int32(count), into: source.mutableAudioBufferList)
        guard status == noErr else { throw recordingError("Could not read audio buffer: \(status)") }
        if converter == nil || converter!.inputFormat != sourceFormat {
            converter = AVAudioConverter(from: sourceFormat, to: format)
            converter?.primeMethod = .none
        }
        guard let converter = converter else { throw recordingError("Unsupported audio device format") }
        let capacity = AVAudioFrameCount(ceil(Double(count) * 48_000 / sourceFormat.sampleRate) + 64)
        guard let output = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { throw recordingError("Could not create an audio buffer") }
        var supplied = false
        var error: NSError?
        let result = converter.convert(to: output, error: &error) { _, state in
            if supplied { state.pointee = .noDataNow; return nil }
            supplied = true; state.pointee = .haveData; return source
        }
        if result == .error { throw error ?? recordingError("Audio conversion failed") }
        guard let bytes = output.int16ChannelData?.pointee else { return Data() }
        return Data(bytes: bytes, count: Int(output.frameLength) * 4)
    }

    func write(_ pcm: Data) throws {
        guard !pcm.isEmpty else { return }
        guard input.isReadyForMoreMediaData else { throw writer.error ?? recordingError("The audio encoder cannot keep up with recording") }
        var block: CMBlockBuffer?
        var status = CMBlockBufferCreateWithMemoryBlock(allocator: kCFAllocatorDefault, memoryBlock: nil,
            blockLength: pcm.count, blockAllocator: kCFAllocatorDefault, customBlockSource: nil,
            offsetToData: 0, dataLength: pcm.count, flags: 0, blockBufferOut: &block)
        guard status == noErr, let block = block else { throw recordingError("Could not create an audio block") }
        status = pcm.withUnsafeBytes { CMBlockBufferReplaceDataBytes(with: $0.baseAddress!, blockBuffer: block, offsetIntoDestination: 0, dataLength: pcm.count) }
        guard status == noErr else { throw recordingError("Could not copy the audio block") }
        let frames = pcm.count / 4
        var timing = CMSampleTimingInfo(duration: CMTime(value: 1, timescale: 48_000),
            presentationTimeStamp: CMTime(value: nextFrame, timescale: 48_000), decodeTimeStamp: .invalid)
        var size = 4
        var sample: CMSampleBuffer?
        status = CMSampleBufferCreateReady(allocator: kCFAllocatorDefault, dataBuffer: block, formatDescription: description,
            sampleCount: frames, sampleTimingEntryCount: 1, sampleTimingArray: &timing,
            sampleSizeEntryCount: 1, sampleSizeArray: &size, sampleBufferOut: &sample)
        guard status == noErr, let sample = sample, input.append(sample) else { throw writer.error ?? recordingError("Could not write the audio block") }
        nextFrame += Int64(frames)
    }

    func pad(to frame: Int64) throws {
        while nextFrame < frame { try write(Data(count: Int(min(480, frame - nextFrame)) * 4)) }
    }

    func write(at position: Double, pcm: Data) throws {
        let start = Int64((position * 48_000).rounded())
        let skip = min(Int64(pcm.count / 4), max(0, nextFrame - start))
        try pad(to: start)
        try write(Data(pcm.dropFirst(Int(skip) * 4)))
    }

    func finish(duration: Double, completion: @escaping (String?) -> Void) {
        do { try pad(to: Int64((duration * 48_000).rounded(.down))) }
        catch { writer.cancelWriting(); completion(error.localizedDescription); return }
        input.markAsFinished()
        writer.finishWriting { completion(self.writer.error?.localizedDescription) }
    }
}
