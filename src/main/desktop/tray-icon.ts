// 占位托盘图标：用代码画一个带眼睛的小圆团，M1 不引入图片素材。

import { nativeImage, type NativeImage } from 'electron';

const BODY = { r: 0xff, g: 0xc4, b: 0x9f };
const EYE = { r: 0x4a, g: 0x35, b: 0x30 };

export function createTrayIcon(): NativeImage {
  const image = nativeImage.createFromBitmap(drawIcon(16), { width: 16, height: 16, scaleFactor: 1 });
  for (const scaleFactor of [1.5, 2]) {
    const size = Math.round(16 * scaleFactor);
    image.addRepresentation({ scaleFactor, width: size, height: size, buffer: drawIcon(size) });
  }
  return image;
}

/** 输出预乘 alpha 的 BGRA 位图 */
function drawIcon(size: number): Buffer {
  const buffer = Buffer.alloc(size * size * 4);
  const c = (size - 1) / 2;
  const bodyRadius = size * 0.44;
  const eyeRadius = size * 0.07;
  const eyes = [
    { x: c - size * 0.16, y: c - size * 0.02 },
    { x: c + size * 0.16, y: c - size * 0.02 },
  ];

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const bodyAlpha = coverage(Math.hypot(x - c, y - c), bodyRadius);
      if (bodyAlpha <= 0) continue;
      const eyeMix = Math.max(...eyes.map((e) => coverage(Math.hypot(x - e.x, y - e.y), eyeRadius)));
      const color = mix(BODY, EYE, eyeMix);
      const i = (y * size + x) * 4;
      buffer[i] = Math.round(color.b * bodyAlpha);
      buffer[i + 1] = Math.round(color.g * bodyAlpha);
      buffer[i + 2] = Math.round(color.r * bodyAlpha);
      buffer[i + 3] = Math.round(255 * bodyAlpha);
    }
  }
  return buffer;
}

/** 边缘 1 像素抗锯齿 */
function coverage(distance: number, radius: number): number {
  return Math.max(0, Math.min(1, radius + 0.5 - distance));
}

function mix(a: typeof BODY, b: typeof BODY, t: number): typeof BODY {
  return { r: a.r + (b.r - a.r) * t, g: a.g + (b.g - a.g) * t, b: a.b + (b.b - a.b) * t };
}
