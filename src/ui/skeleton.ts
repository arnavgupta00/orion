import type { HandObservation } from '../core/types';

const CONNECTIONS: Array<[number, number]> = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20], [0, 17],
];

export function drawCameraPreview(
  canvas: HTMLCanvasElement,
  video: HTMLVideoElement,
  hands: HandObservation[],
  showSkeleton: boolean,
): void {
  const width = canvas.clientWidth;
  const height = canvas.clientHeight;
  if (width === 0 || height === 0) return;
  const dpr = Math.min(window.devicePixelRatio, 2);
  const pixelWidth = Math.round(width * dpr);
  const pixelHeight = Math.round(height * dpr);
  if (canvas.width !== pixelWidth || canvas.height !== pixelHeight) {
    canvas.width = pixelWidth;
    canvas.height = pixelHeight;
  }

  const context = canvas.getContext('2d');
  if (!context) return;
  context.setTransform(dpr, 0, 0, dpr, 0, 0);
  context.clearRect(0, 0, width, height);

  if (video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
    context.save();
    context.translate(width, 0);
    context.scale(-1, 1);
    context.drawImage(video, 0, 0, width, height);
    context.restore();
  } else {
    const gradient = context.createLinearGradient(0, 0, width, height);
    gradient.addColorStop(0, '#0b0e14');
    gradient.addColorStop(1, '#1b0b0b');
    context.fillStyle = gradient;
    context.fillRect(0, 0, width, height);
  }

  context.fillStyle = 'rgba(3, 5, 10, .34)';
  context.fillRect(0, 0, width, height);
  if (!showSkeleton) return;

  hands.forEach((hand, handIndex) => {
    const color = handIndex === 0 ? '#61efff' : '#8b5cff';
    context.strokeStyle = color;
    context.fillStyle = color;
    context.lineWidth = 1.4;
    context.globalAlpha = 0.88;
    for (const [startIndex, endIndex] of CONNECTIONS) {
      const start = hand.landmarks[startIndex];
      const end = hand.landmarks[endIndex];
      if (!start || !end) continue;
      context.beginPath();
      context.moveTo((1 - start.x) * width, start.y * height);
      context.lineTo((1 - end.x) * width, end.y * height);
      context.stroke();
    }
    hand.landmarks.forEach((landmark, index) => {
      context.beginPath();
      context.arc(
        (1 - landmark.x) * width,
        landmark.y * height,
        index === 4 || index === 8 ? 3.2 : 1.8,
        0,
        Math.PI * 2,
      );
      context.fill();
    });
  });
  context.globalAlpha = 1;
}
