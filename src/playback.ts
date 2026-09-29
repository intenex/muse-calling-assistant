import { from64, to64 } from "./security";
// Tracks carrier acknowledgments separately from text. A clear also returns marks;
// invalidate them before sending clear, so they cannot be reported as played.
export class Playback {
  private queue: Uint8Array[] = [];
  private queuedBytes = 0;
  private generation = 0;
  private counter = 0;
  private pending = new Map<
    string,
    { bytes: number; generation: number; startByte: number }
  >();
  private remainder: Uint8Array = new Uint8Array(0);
  private tickCount = 0;
  playedBytes = 0;
  clearedBytes = 0;
  sentBytes = 0;
  constructor(
    private bytesPerSecond: number,
    private send: (e: unknown) => void,
  ) {}
  enqueue(audio: string) {
    const b = from64(audio);
    if (this.queuedBytes + b.length > this.bytesPerSecond * 2)
      throw new Error("audio_backpressure");
    this.queue.push(b);
    this.queuedBytes += b.length;
  }
  tick() {
    const size = this.bytesPerSecond / 50;
    let frame = new Uint8Array(size),
      offset = 0;
    while (offset < size) {
      if (!this.remainder.length) {
        const b = this.queue.shift();
        if (!b) break;
        this.remainder = b;
      }
      const n = Math.min(size - offset, this.remainder.length);
      frame.set(this.remainder.subarray(0, n), offset);
      offset += n;
      this.remainder = this.remainder.subarray(n);
      this.queuedBytes -= n;
    }
    if (!offset) return;
    frame = frame.subarray(0, offset);
    this.send({ event: "media", media: { payload: to64(frame) } });
    this.sentBytes += offset;
    const name = `${this.generation}:${++this.counter}`;
    this.pending.set(name, {
      bytes: offset,
      generation: this.generation,
      startByte: this.sentBytes - offset,
    });
    this.send({ event: "mark", mark: { name } });
    if (++this.tickCount % 50 === 0 && this.pending.size > 150)
      throw new Error("playback_ack_timeout");
  }
  mark(name: string) {
    const p = this.pending.get(name);
    if (!p) return;
    this.pending.delete(name);
    if (p.generation === this.generation) this.playedBytes += p.bytes;
  }
  clear() {
    this.generation++;
    this.clearedBytes +=
      this.queuedBytes +
      [...this.pending.values()].reduce((n, p) => n + p.bytes, 0);
    this.queue = [];
    this.remainder = new Uint8Array(0);
    this.queuedBytes = 0;
    this.pending.clear();
    this.send({ event: "clear" });
  }
  checkpoint() {
    return {
      generation: this.generation,
      throughBytes: this.sentBytes + this.queuedBytes,
    };
  }
  acknowledged(checkpoint: ReturnType<Playback["checkpoint"]>) {
    return (
      checkpoint.generation === this.generation &&
      this.sentBytes >= checkpoint.throughBytes &&
      ![...this.pending.values()].some(
        (p) => p.startByte < checkpoint.throughBytes,
      )
    );
  }
  snapshot() {
    return {
      playedBytes: this.playedBytes,
      clearedBytes: this.clearedBytes,
      sentBytes: this.sentBytes,
      pendingMarks: this.pending.size,
      queuedBytes: this.queuedBytes,
    };
  }
}

/** Fixed-size PCM/PCMU input frames; no VAD or speech resampling. */
export class AudioFrames {
  private chunks: Uint8Array[] = [];
  private remaining: Uint8Array = new Uint8Array(0);
  private size = 0;
  constructor(
    private frameBytes: number,
    private silenceByte = 0,
  ) {}
  startLive() {
    // A startup backlog would otherwise remain in front of every later word:
    // input and consumption both advance at exactly the real-time sample rate.
    // Retain only a 60 ms onset window when the model becomes ready.
    const keep = this.frameBytes * 3;
    let discard = Math.max(0, this.size - keep);
    while (discard > 0) {
      if (!this.remaining.length) this.remaining = this.chunks.shift()!;
      const n = Math.min(discard, this.remaining.length);
      this.remaining = this.remaining.subarray(n);
      this.size -= n;
      discard -= n;
    }
  }
  snapshot() {
    return { queuedMs: (this.size / this.frameBytes) * 20 };
  }
  enqueue(encoded: string, startup = false) {
    const data = from64(encoded);
    // Session establishment can take longer than the two-second audio window.
    // Keep only bounded pre-roll rather than failing an otherwise healthy call.
    if (startup && this.size + data.length > this.frameBytes * 100) {
      this.chunks = [];
      this.remaining = new Uint8Array(0);
      this.size = 0;
    }
    if (this.size + data.length > this.frameBytes * 100)
      throw new Error("input_audio_backpressure");
    this.chunks.push(data);
    this.size += data.length;
  }
  next() {
    const frame = new Uint8Array(this.frameBytes);
    frame.fill(this.silenceByte);
    let offset = 0;
    while (offset < this.frameBytes) {
      if (!this.remaining.length) {
        const next = this.chunks.shift();
        if (!next) break;
        this.remaining = next;
      }
      const n = Math.min(this.frameBytes - offset, this.remaining.length);
      frame.set(this.remaining.subarray(0, n), offset);
      this.remaining = this.remaining.subarray(n);
      offset += n;
      this.size -= n;
    }
    return to64(frame);
  }
}
