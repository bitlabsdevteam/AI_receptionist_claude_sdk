/** What the Voice needs to know about a recorded clip before it is uploaded: whether it is WAV, and how long it is. */

/**
 * The length of a WAV clip in ms. A clip in another format, or one whose length cannot be told, counts as long enough,
 * unless it is empty. The audio is measured from where the `data` chunk starts to the end of the clip, since ffmpeg
 * puts a `LIST` chunk before it and can leave the declared size stale.
 */
export function clipMs(clip: Uint8Array): number {
  if (clip.byteLength === 0) return 0;
  if (!isWav(clip)) return Infinity;
  const view = new DataView(clip.buffer, clip.byteOffset, clip.byteLength);

  let byteRate = 0;
  for (let chunk = 12; chunk + 8 <= clip.byteLength; ) {
    const body = chunk + 8;
    const size = view.getUint32(chunk + 4, true);
    if (tagAt(clip, chunk) === "fmt " && body + 12 <= clip.byteLength) byteRate = view.getUint32(body + 8, true);
    if (tagAt(clip, chunk) === "data") return byteRate === 0 ? Infinity : ((clip.byteLength - body) / byteRate) * 1000;
    chunk = body + size + (size % 2);
  }
  // A WAV with no audio chunk at all has nothing in it to hear.
  return 0;
}

export function isWav(clip: Uint8Array): boolean {
  return clip.byteLength >= 12 && tagAt(clip, 0) === "RIFF" && tagAt(clip, 8) === "WAVE";
}

/** The four-letter tag at `offset`, which is how a WAV names itself and each of its chunks. */
function tagAt(clip: Uint8Array, offset: number): string {
  return String.fromCharCode(...clip.subarray(offset, offset + 4));
}
