// 사진 축소·회전·base64 변환
const MAX_SIDE = 1600;

function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('사진을 열 수 없어요.')); };
    img.src = url;
  });
}

function canvasToBlob(canvas, quality = 0.85) {
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
}

// 촬영 사진을 최대 1600px JPEG으로 축소 (iPad 사진은 4000px 이상이라 저장·전송 부담이 큼)
export async function normalizeImage(file) {
  const img = await loadImage(file);
  const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
  const w = Math.round(img.naturalWidth * scale);
  const h = Math.round(img.naturalHeight * scale);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(img, 0, 0, w, h);
  return canvasToBlob(c);
}

export async function rotateImage(blob, clockwise = true) {
  const img = await loadImage(blob);
  const c = document.createElement('canvas');
  c.width = img.naturalHeight; c.height = img.naturalWidth;
  const ctx = c.getContext('2d');
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((clockwise ? 1 : -1) * Math.PI / 2);
  ctx.drawImage(img, -img.naturalWidth / 2, -img.naturalHeight / 2);
  return canvasToBlob(c, 0.9);
}

export function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });
}
