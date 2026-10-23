import { useCallback, useEffect, useRef, useState } from 'react';

// VS Code-style drag-to-resize for split panes. One pointer/mouse/touch drag updates a CSS custom
// property live on the owning container (no re-render per move), a double-click resets to the
// default, arrow keys resize via the keyboard (role="separator" a11y), and the chosen size
// persists to localStorage. RTL mirrors the drag direction, and everything degrades to the
// stylesheet default below/between the owner's own breakpoints — mobile stack rules simply win
// because the sash is hidden there.
//
// CSS contract (owner supplies the variables; values may live inside the owner's media queries):
//   --<var>: <default>px            on the container returned by the hook
//   --<var>-min / --<var>-max: Npx  drag + clamp bounds (px, unitless numbers NOT supported)
//   .pane-sash                      absolutely-positioned between the panes (width 10px, grab
//                                   border, hover/drag highlight via the shared rule in App.css)
// LocalStorage guard: tests and private modes throw on access; a dead store only costs persistence.

const safeGet = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};

const safeSet = (key: string, value: string) => {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* storage unavailable: session-only sizing */
  }
};

/** Signed distance from the measured edge; the sign mirrors RTL and end-edge sashes. */
export function dragOffset(clientX: number, anchor: number, measureFromLeft: boolean): number {
  return (clientX - anchor) * (measureFromLeft ? 1 : -1);
}

export function clampPx(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function readVarPx(el: HTMLElement, name: string, fallback: number): number {
  const raw = el.computedStyleMap?.().get(name)?.toString() ?? getComputedStyle(el).getPropertyValue(name);
  const parsed = parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export interface PaneResizerApi {
  /** Attach to the element whose `--<var>` custom property the sash drives. */
  containerRef: (node: HTMLElement | null) => void;
  /** Spread onto the handle between the panes. */
  sashProps: {
    role: 'separator';
    'aria-orientation': 'vertical';
    tabIndex: 0;
    'aria-valuenow': number;
    'aria-valuemin': number;
    'aria-valuemax': number;
    'aria-label': string;
    onDoubleClick: () => void;
    onKeyDown: (event: React.KeyboardEvent) => void;
    onPointerDown: (event: React.PointerEvent) => void;
    className: string;
  };
  /** The sash tracks user-resizable state only; `false` restores the stylesheet default. */
  isResized: boolean;
}

export interface PaneResizerOptions {
  /** CSS custom property the hook writes, e.g. `--chats-sidebar-w`. */
  cssVar: string;
  /** LocalStorage key, namespaced `openwa_` like every other persisted preference. */
  storageKey: string;
  /** Which container edge the pane grows from: `"start"` (the default) or `"end"`. */
  edge?: 'start' | 'end';
  /** Keyboard step (Shift = fine 4px); VS Code uses coarse 32px, the default here. */
  step?: number;
}

/**
 * One sash between two panes of the container the hook is attached to. `ariaLabel` is the
 * translated `common.panelResize` string, so the separator gets a localized accessible name.
 */

export function usePaneResizer(ariaLabel: string, options: PaneResizerOptions): PaneResizerApi {
  const { cssVar, storageKey, step = 32, edge = 'start' } = options;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [value, setValue] = useState<number | null>(() => {
    const saved = safeGet(storageKey);
    return saved !== null && Number.isFinite(parseFloat(saved)) ? parseFloat(saved) : null;
  });
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const state = useRef({ anchor: 0, sign: 1, host: null as HTMLElement | null });
  // Registry for pointer capture fallback (older Safari): sash → move/up listeners.
  const cleanupRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    if (!container) return;
    if (value !== null) {
      container.style.setProperty(cssVar, `${Math.round(value)}px`);
    } else {
      container.style.removeProperty(cssVar);
    }
  }, [container, cssVar, value]);

  const store = useCallback(
    (next: number | null) => {
      setValue(next);
      if (next === null) safeSet(storageKey, '');
      else safeSet(storageKey, String(Math.round(next)));
    },
    [storageKey],
  );

  const beginDrag = useCallback(
    (event: React.PointerEvent) => {
      const sash = event.currentTarget as HTMLElement;
      // The pane geometry lives on the container the hook is attached to, never on the sash's
      // parent: the sash may sit one level down (Chats keeps it inside the room scroller) while
      // the variable belongs to the grid/flex owner. No container attached -> nothing to drive.
      const host = container;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const rtl = document.documentElement.getAttribute('dir') === 'rtl';
      // LTR start-edge (Chats list, nav) measures from the left; an end-edge sash (Templates
      // preview) measures from the right. RTL mirrors both, so the sign alone flips the math.
      const fromStart = edge !== 'end';
      const measureFromLeft = fromStart === !rtl;
      state.current = {
        anchor: measureFromLeft ? rect.left : rect.right,
        sign: measureFromLeft ? 1 : -1,
        host,
      };
      setDragging(true);
      document.body.classList.add('pane-resizing');
      // Attach first (document fallback), then capture: when capture sticks the element listeners
      // shadow the document ones anyway; when it throws (synthetic events, some jsdom runs) the
      // document listeners still deliver every move.
      let detach: (() => void) | null;

      // Event-typed so it binds to both element and document listeners without a cast; pointer
      // events are the only ones attached under these names.
      const onMove = (moveEvent: Event) => {
        cancelAnimationFrame(frame.current);
        const point = moveEvent as PointerEvent;
        frame.current = requestAnimationFrame(() => {
          const { anchor, sign, host: target } = state.current;
          if (!target) return;
          const offset = dragOffset(point.clientX, anchor, sign === 1);
          const min = readVarPx(target, `${cssVar}-min`, 0);
          const max = readVarPx(target, `${cssVar}-max`, Math.max(min, target.getBoundingClientRect().width));
          const next = clampPx(offset, min, max);
          target.style.setProperty(cssVar, `${Math.round(next)}px`);
        });
      };

      let draggingWidth: number | null = null;
      const commit = () => {
        cancelAnimationFrame(frame.current);
        document.body.classList.remove('pane-resizing');
        setDragging(false);
        const { host: target } = state.current;
        if (target && draggingWidth === null) {
          const raw = target.style.getPropertyValue(cssVar).trim();
          draggingWidth = raw ? parseFloat(raw) : null;
        }
        if (draggingWidth !== null) store(draggingWidth);
        cleanupRef.current?.();
        cleanupRef.current = null;
      };
      const onUp = () => commit();

      // The listeners land on either the sash (pointer capture) or the document (no capture).
      // EventTarget loses the per-pointer-event typing; one targeted cast at the boundary is
      // cheaper than overloading per target kind.
      const onPointer = (target: EventTarget) => {
        target.addEventListener('pointermove', onMove);
        target.addEventListener('pointerup', onUp);
        target.addEventListener('pointercancel', onUp);
        return () => {
          target.removeEventListener('pointermove', onMove);
          target.removeEventListener('pointerup', onUp);
          target.removeEventListener('pointercancel', onUp);
        };
      };
      detach = onPointer(document);
      sash.setPointerCapture?.(event.pointerId);
      if (typeof sash.hasPointerCapture === 'function' && sash.hasPointerCapture(event.pointerId)) {
        detach();
        detach = onPointer(sash);
      }
      cleanupRef.current = detach;
    },
    [container, cssVar, edge, store],
  );

  useEffect(
    () => () => {
      cleanupRef.current?.();
      cancelAnimationFrame(frame.current);
      document.body.classList.remove('pane-resizing');
    },
    [],
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      // Arrow semantics stay screen-relative regardless of the measured edge: ArrowLeft narrows a
      // start-edge pane and widens an end-edge one; RTL flips both.
      const increments = event.shiftKey ? 4 : step;
      const sign =
        (document.documentElement.getAttribute('dir') === 'rtl' ? -1 : 1) *
        (edge === 'start' ? 1 : -1);
      const target = state.current.host ?? (event.currentTarget as HTMLElement).parentElement;
      if (!target) return;
      const min = readVarPx(target, `${cssVar}-min`, 0);
      const max = readVarPx(target, `${cssVar}-max`, target.getBoundingClientRect().width);

      const apply = (delta: number) => {
        const current = value ?? readVarPx(target, cssVar, min);
        store(clampPx(current + delta * sign, min, max));
      };
      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          apply(-increments);
          break;
        case 'ArrowRight':
          event.preventDefault();
          apply(increments);
          break;
        case 'Home':
          event.preventDefault();
          store(min);
          break;
        case 'End':
          event.preventDefault();
          store(max);
          break;
        case 'Enter':
          // Enter on a separator restores the stylesheet default, matching the double-click.
          event.preventDefault();
          store(null);
          break;
        default:
          break;
      }
    },
    [cssVar, edge, step, store, value],
  );

  const minForAria = container ? readVarPx(container, `${cssVar}-min`, 0) : 0;

  return {
    containerRef: setContainer,
    sashProps: {
      role: 'separator',
      'aria-orientation': 'vertical',
      tabIndex: 0,
      'aria-valuenow': Math.round(value ?? minForAria),
      'aria-valuemin': Math.round(minForAria),
      // Give the sash an upper bound even before the first drag reads the live layout.
      'aria-valuemax': Math.round(value ?? 800),
      'aria-label': ariaLabel,
      onDoubleClick: () => store(null),
      onKeyDown,
      onPointerDown: beginDrag,
      className: dragging ? 'pane-sash dragging' : 'pane-sash',
    },
    isResized: value !== null,
  };
}
