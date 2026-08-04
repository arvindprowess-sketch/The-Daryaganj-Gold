// Client-side image compression: max 1200px long edge before upload.
// Phone photos are 3–6 MB and choke on outlet wifi; we shrink first.
export async function compressImage(file, maxEdge = 1200, quality = 0.8) {
  const okTypes = ['image/jpeg', 'image/jpg', 'image/png', 'image/webp'];
  if (!okTypes.includes(file.type)) {
    throw new Error('Unsupported image type (use jpg, png or webp)');
  }
  const bitmap = await createImageBitmap(file).catch(() => null);
  const img = bitmap || (await loadViaImg(file));
  const w = img.width;
  const h = img.height;
  const scale = Math.min(1, maxEdge / Math.max(w, h));
  const cw = Math.round(w * scale);
  const ch = Math.round(h * scale);

  const canvas = document.createElement('canvas');
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, cw, ch);

  const blob = await new Promise((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', quality)
  );
  return new File([blob], (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg', {
    type: 'image/jpeg',
  });
}

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}
