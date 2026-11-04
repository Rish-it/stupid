/** A subject's box from SAM 3.1, in the pixels of a `w`×`h` picture. */
export type Box = { x1: number; y1: number; x2: number; y2: number; w: number; h: number };
export type Crop = { id: string; permalink?: string; caption?: string; subject: string; box: Box | null; note: string | null };
/** Ad placements and their shapes, width over height. */
export const ratios = [{ label: "1:1", name: "Feed", a: 1 }, { label: "4:5", name: "Feed, tall", a: 4 / 5 }, { label: "9:16", name: "Stories and Reels", a: 9 / 16 }] as const;

/** The largest `a`-shaped crop of a `w`×`h` picture, centred on the box (or the middle) and kept inside the picture. */
export function cropRect(w: number, h: number, a: number, box: Box | null) {
  const [cw, ch] = w / h > a ? [h * a, h] : [w, w / a];
  const cx = box ? ((box.x1 + box.x2) / 2) * (w / box.w) : w / 2;
  const cy = box ? ((box.y1 + box.y2) / 2) * (h / box.h) : h / 2;
  const clamp = (v: number, max: number) => Math.min(Math.max(v, 0), max);
  return { x: clamp(cx - cw / 2, w - cw), y: clamp(cy - ch / 2, h - ch), cw, ch };
}

/** The same crop as CSS `object-position` for an `object-fit: cover` preview. */
export function objectPosition(a: number, box: Box | null) {
  if (!box) return "50% 50%";
  const { x, y, cw, ch } = cropRect(box.w, box.h, a, box);
  const pct = (offset: number, spare: number) => `${spare > 0 ? Math.round((offset / spare) * 100) : 50}%`;
  return `${pct(x, box.w - cw)} ${pct(y, box.h - ch)}`;
}

/** Crop the picture in the browser and save it as a PNG, at most 1080 px wide. */
export async function savePng(src: string, a: number, box: Box | null, name: string) {
  const img = new Image();
  img.src = src;
  await img.decode();
  const { x, y, cw, ch } = cropRect(img.naturalWidth, img.naturalHeight, a, box);
  const scale = Math.min(1, 1080 / cw);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(cw * scale);
  canvas.height = Math.round(ch * scale);
  canvas.getContext("2d")!.drawImage(img, x, y, cw, ch, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>(done => canvas.toBlob(done, "image/png"));
  if (!blob) throw new Error("Couldn't make the picture.");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
