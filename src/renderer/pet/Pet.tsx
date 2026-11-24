import { useCallback, useEffect, useRef, useState, type PointerEvent } from 'react';
import { DragGesture } from './drag-gesture';
import { PetFigure, type PetPose } from './PetFigure';

/** 一次性姿态播放多久后回到待机 */
const POSE_DURATION_MS: Partial<Record<PetPose, number>> = {
  landing: 420,
  touched: 600,
};

const HIT_SELECTOR = '[data-pet-hit]';

export function Pet() {
  const [pose, setPose] = useState<PetPose>('idle');
  const gesture = useRef(new DragGesture());
  const interactive = useRef(false);
  const poseTimer = useRef<number | undefined>(undefined);

  const playPose = useCallback((next: PetPose) => {
    window.clearTimeout(poseTimer.current);
    setPose(next);
    const duration = POSE_DURATION_MS[next];
    if (duration) poseTimer.current = window.setTimeout(() => setPose('idle'), duration);
  }, []);

  const setInteractive = useCallback((value: boolean) => {
    if (interactive.current === value) return;
    interactive.current = value;
    window.petBridge.setInteractive(value);
  }, []);

  const updateHit = useCallback(
    (clientX: number, clientY: number) => {
      const element = document.elementFromPoint(clientX, clientY);
      setInteractive(!!element?.closest(HIT_SELECTOR));
    },
    [setInteractive],
  );

  // 穿透状态下主进程仍会转发鼠标移动，用它判断指针是否进入角色轮廓（TD §12.2）
  useEffect(() => {
    const onMouseMove = (event: MouseEvent): void => {
      if (gesture.current.phase === 'idle') updateHit(event.clientX, event.clientY);
    };
    const onMouseLeave = (): void => {
      if (gesture.current.phase === 'idle') setInteractive(false);
    };
    window.addEventListener('mousemove', onMouseMove);
    document.documentElement.addEventListener('mouseleave', onMouseLeave);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      document.documentElement.removeEventListener('mouseleave', onMouseLeave);
    };
  }, [setInteractive, updateHit]);

  useEffect(
    () =>
      window.petBridge.onEvent((event) => {
        if (event.type === 'drag-cancelled') {
          gesture.current.reset();
          playPose('landing');
        } else if (event.type === 'summoned') {
          playPose('landing');
        }
      }),
    [playPose],
  );

  useEffect(() => () => window.clearTimeout(poseTimer.current), []);

  const onPointerDown = (event: PointerEvent<HTMLDivElement>): void => {
    if (event.button !== 0) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current.down(event.pointerId, event.screenX, event.screenY);
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>): void => {
    if (gesture.current.move(event.pointerId, event.screenX, event.screenY) === 'drag-start') {
      window.petBridge.dragStart();
      playPose('lifted');
    }
  };

  const onPointerUp = (event: PointerEvent<HTMLDivElement>): void => {
    const result = gesture.current.up(event.pointerId);
    if (result === 'touch') playPose('touched');
    if (result === 'drag-end') {
      window.petBridge.dragEnd();
      playPose('landing');
    }
    updateHit(event.clientX, event.clientY);
  };

  // 失去指针捕获（例如被系统打断）时也必须结束拖动（R02.AC-3）
  const onPointerCancel = (): void => {
    if (gesture.current.cancel() === 'drag-end') {
      window.petBridge.dragEnd();
      playPose('landing');
    }
  };

  return (
    <div className={`pet pose-${pose}`} onContextMenu={(event) => event.preventDefault()}>
      <PetFigure pose={pose} />
      <div
        className="pet-hit"
        data-pet-hit
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerCancel}
        onLostPointerCapture={onPointerCancel}
      />
    </div>
  );
}
