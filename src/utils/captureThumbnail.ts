/** Captures a small JPEG data-URL from a video object URL, for history cards.
 *  Seeks a quarter of the way in (first frames are often black). Resolves to
 *  null on any failure — a missing thumbnail must never break the flow. */
export function captureThumbnail(
  videoUrl: string,
  maxWidth = 192,
): Promise<string | null> {
  return new Promise((resolve) => {
    const video = document.createElement("video");
    video.muted = true;
    video.playsInline = true;
    video.preload = "auto";
    video.src = videoUrl;

    const finish = (value: string | null) => {
      video.removeAttribute("src");
      resolve(value);
    };
    const timeout = setTimeout(() => finish(null), 5000);

    video.addEventListener("error", () => {
      clearTimeout(timeout);
      finish(null);
    });

    video.addEventListener("loadeddata", () => {
      const target = Number.isFinite(video.duration) ? video.duration * 0.25 : 0;
      const onSeeked = () => {
        try {
          const scale = Math.min(1, maxWidth / (video.videoWidth || maxWidth));
          const canvas = document.createElement("canvas");
          canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
          canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
          const ctx = canvas.getContext("2d");
          if (!ctx) throw new Error("no 2d context");
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
          clearTimeout(timeout);
          finish(canvas.toDataURL("image/jpeg", 0.7));
        } catch {
          clearTimeout(timeout);
          finish(null);
        }
      };
      video.addEventListener("seeked", onSeeked, { once: true });
      video.currentTime = target;
    });
  });
}
