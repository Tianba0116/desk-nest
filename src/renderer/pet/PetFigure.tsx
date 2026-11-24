// 占位角色：一个带耳朵的小圆团。正式原创角色在 P2 替换（R04、D-10）。

import { useEffect, useState } from 'react';

export type PetPose = 'idle' | 'lifted' | 'landing' | 'touched';

const BLINK_MIN_INTERVAL_MS = 2500;
const BLINK_MAX_INTERVAL_MS = 6000;
const BLINK_DURATION_MS = 140;

export function PetFigure({ pose }: { pose: PetPose }) {
  const lifted = pose === 'lifted';
  const blinking = useBlink(!lifted);

  return (
    <svg className="pet-figure" viewBox="0 0 160 160" aria-hidden="true">
      <ellipse className="pet-shadow" cx="80" cy="146" rx="34" ry="6" />
      <g className="pet-body">
        <g className="pet-feet">
          <ellipse cx="62" cy="140" rx="11" ry="6" />
          <ellipse cx="98" cy="140" rx="11" ry="6" />
        </g>
        <ellipse className="pet-ear" cx="52" cy="70" rx="12" ry="16" transform="rotate(-22 52 70)" />
        <ellipse className="pet-ear" cx="108" cy="70" rx="12" ry="16" transform="rotate(22 108 70)" />
        <ellipse className="pet-skin" cx="80" cy="104" rx="48" ry="40" />
        <ellipse className="pet-belly" cx="80" cy="116" rx="26" ry="17" />
        <ellipse className="pet-blush" cx="53" cy="110" rx="7" ry="4" />
        <ellipse className="pet-blush" cx="107" cy="110" rx="7" ry="4" />
        {lifted ? (
          <g className="pet-eyes-lifted">
            <path d="M58 92 L67 97 L58 102" />
            <path d="M102 92 L93 97 L102 102" />
            <circle className="pet-mouth-o" cx="80" cy="108" r="3.5" />
          </g>
        ) : (
          <g className={blinking ? 'pet-eyes blinking' : 'pet-eyes'}>
            <g className="pet-eye">
              <ellipse cx="64" cy="97" rx="5" ry="6.5" />
              <circle className="pet-eye-shine" cx="65.6" cy="94.6" r="1.6" />
            </g>
            <g className="pet-eye">
              <ellipse cx="96" cy="97" rx="5" ry="6.5" />
              <circle className="pet-eye-shine" cx="97.6" cy="94.6" r="1.6" />
            </g>
            <path className="pet-mouth" d="M75 107 Q80 111 85 107" />
          </g>
        )}
      </g>
    </svg>
  );
}

function useBlink(enabled: boolean): boolean {
  const [blinking, setBlinking] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setBlinking(false);
      return;
    }
    let timer: number;
    const schedule = (): void => {
      const wait = BLINK_MIN_INTERVAL_MS + Math.random() * (BLINK_MAX_INTERVAL_MS - BLINK_MIN_INTERVAL_MS);
      timer = window.setTimeout(() => {
        setBlinking(true);
        timer = window.setTimeout(() => {
          setBlinking(false);
          schedule();
        }, BLINK_DURATION_MS);
      }, wait);
    };
    schedule();
    return () => window.clearTimeout(timer);
  }, [enabled]);

  return blinking;
}
