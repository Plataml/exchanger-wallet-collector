import { Page, ElementHandle } from 'playwright';
import { logger } from '../logger';

interface Point {
  x: number;
  y: number;
}

function generateBezierPath(start: Point, end: Point, steps: number): Point[] {
  const dx = end.x - start.x;
  const dy = end.y - start.y;

  // 2 random control points for cubic Bezier
  const cp1: Point = {
    x: start.x + dx * (0.2 + Math.random() * 0.3),
    y: start.y + dy * (0.1 + Math.random() * 0.5) + (Math.random() - 0.5) * 100,
  };
  const cp2: Point = {
    x: start.x + dx * (0.5 + Math.random() * 0.3),
    y: start.y + dy * (0.5 + Math.random() * 0.4) + (Math.random() - 0.5) * 80,
  };

  const points: Point[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const mt = 1 - t;

    // Cubic Bezier formula: B(t) = (1-t)^3*P0 + 3(1-t)^2*t*P1 + 3(1-t)*t^2*P2 + t^3*P3
    const x = mt * mt * mt * start.x +
              3 * mt * mt * t * cp1.x +
              3 * mt * t * t * cp2.x +
              t * t * t * end.x;

    const y = mt * mt * mt * start.y +
              3 * mt * mt * t * cp1.y +
              3 * mt * t * t * cp2.y +
              t * t * t * end.y;

    points.push({ x: Math.round(x), y: Math.round(y) });
  }

  return points;
}

function getStepDelay(progress: number): number {
  // Ease-in-out: slower at start and end, faster in middle
  const easeInOut = 0.5 - Math.cos(progress * Math.PI) / 2;
  const baseDelay = 3;
  const variance = 8;
  return baseDelay + variance * (1 - easeInOut) + Math.random() * 3;
}

export async function humanClick(
  page: Page,
  target: string | ElementHandle,
  options: {
    enabled?: boolean;
    steps?: number;
    offsetRange?: number;
  } = {}
): Promise<void> {
  const { enabled = true, steps = 25, offsetRange = 5 } = options;

  let element: ElementHandle | null;
  if (typeof target === 'string') {
    element = await page.$(target);
    if (!element) {
      logger.debug(`humanClick: element not found: ${target}, falling back to page.click`);
      await page.click(target);
      return;
    }
  } else {
    element = target;
  }

  if (!enabled) {
    await element.click();
    return;
  }

  const box = await element.boundingBox();
  if (!box) {
    await element.click();
    return;
  }

  // Target: center of element with random offset
  const targetPoint: Point = {
    x: box.x + box.width / 2 + (Math.random() - 0.5) * 2 * offsetRange,
    y: box.y + box.height / 2 + (Math.random() - 0.5) * 2 * offsetRange,
  };

  // Start from a random reasonable position
  const viewport = page.viewportSize() || { width: 1280, height: 720 };
  const startPoint: Point = {
    x: Math.random() * viewport.width * 0.8 + viewport.width * 0.1,
    y: Math.random() * viewport.height * 0.8 + viewport.height * 0.1,
  };

  const path = generateBezierPath(startPoint, targetPoint, steps);

  // Move along path with variable speed
  for (let i = 0; i < path.length; i++) {
    await page.mouse.move(path[i].x, path[i].y);
    const delay = getStepDelay(i / path.length);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  // Human hesitation before click
  await new Promise(resolve => setTimeout(resolve, 50 + Math.random() * 150));

  await page.mouse.click(
    targetPoint.x + (Math.random() - 0.5) * 2,
    targetPoint.y + (Math.random() - 0.5) * 2
  );

  logger.debug('humanClick: performed human-like click');
}
