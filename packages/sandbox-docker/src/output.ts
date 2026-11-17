/**
 * Collects a stream of bytes but keeps at most `limit` of them: the first half and the last half.
 * The start of a command's output says what it was doing and the end says how it finished; the middle is
 * what gets dropped. Commands that produce a lot should write to a file under /work instead.
 */
export class OutputBuffer {
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer[] = [];
  private tail: Buffer[] = [];
  private headBytes = 0;
  private tailBytes = 0;
  private total = 0;

  constructor(limit: number) {
    this.headLimit = Math.ceil(limit / 2);
    this.tailLimit = Math.floor(limit / 2);
  }

  push(chunk: Buffer): void {
    this.total += chunk.length;
    let rest = chunk;
    if (this.headBytes < this.headLimit) {
      const take = rest.subarray(0, this.headLimit - this.headBytes);
      this.head.push(take);
      this.headBytes += take.length;
      rest = rest.subarray(take.length);
    }
    if (rest.length === 0 || this.tailLimit === 0) return;
    this.tail.push(rest);
    this.tailBytes += rest.length;
    // Drop whole chunks from the front, then trim the first remaining chunk to fit.
    while (this.tail.length > 1 && this.tailBytes - this.tail[0]!.length >= this.tailLimit) {
      this.tailBytes -= this.tail.shift()!.length;
    }
    const overflow = this.tailBytes - this.tailLimit;
    if (overflow > 0) {
      this.tail[0] = this.tail[0]!.subarray(overflow);
      this.tailBytes -= overflow;
    }
  }

  /** Bytes seen, including the ones that were dropped. */
  get bytes(): number {
    return this.total;
  }

  get truncated(): boolean {
    return this.total > this.headBytes + this.tailBytes;
  }

  toString(): string {
    const head = Buffer.concat(this.head).toString("utf8");
    if (!this.truncated) return head + Buffer.concat(this.tail).toString("utf8");
    const omitted = this.total - this.headBytes - this.tailBytes;
    return `${head}\n[... ${omitted} bytes left out ...]\n${Buffer.concat(this.tail).toString("utf8")}`;
  }
}
