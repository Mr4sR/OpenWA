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

const clampPx = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

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
  /** Keyboard step (Shift = fine 4px); VS Code uses coarse 32px, the default here. */
  step?: number;
}

/**
 * One sash between two panes of the container the hook is attached to. `ariaLabel` is the
 * translated `common.panelResize` string, so the separator gets a localized accessible name.
 */

export function usePaneResizer(ariaLabel: string, options: PaneResizerOptions): PaneResizerApi {
  const { cssVar, storageKey, step = 32 } = options;
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [value, setValue] = useState<number | null>(() => {
    const saved = safeGet(storageKey);
    return saved !== null && Number.isFinite(parseFloat(saved)) ? parseFloat(saved) : null;
  });
  const [dragging, setDragging] = useState(false);
  const frame = useRef(0);
  const state = useRef({ rect: new DOMRect(), rtl: 1, host: null as HTMLElement | null });
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
      const host = sash.parentElement;
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const dir = document.documentElement.getAttribute('dir') === 'rtl' ? -1 : 1;
      state.current = { rect, rtl: dir, host };
      setDragging(true);
      document.body.classList.add('pane-resizing');
      sash.setPointerCapture?.(event.pointerId);

      const onMove = (moveEvent: PointerEvent) => {
        cancelAnimationFrame(frame.current);
        frame.current = requestAnimationFrame(() => {
          const { rect: box, rtl, host: target } = state.current;
          if (!target) return;
          // Distance from the pane's fixed edge, mirrored under RTL.
          const offset = rtl === 1 ? moveEvent.clientX - box.left : box.right - moveEvent.clientX;
          const min = readVarPx(target, `${cssVar}-min`, 0);
          const max = readVarPx(target, `${cssVar}-max`, Math.max(min, box.width));
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

      let detach: () => void;
      if (typeof sash.hasPointerCapture === 'function' && sash.hasPointerCapture(event.pointerId)) {
        sash.addEventListener('pointermove', onMove);
        sash.addEventListener('pointerup', onUp);
        sash.addEventListener('pointercancel', onUp);
        detach = () => {
          sash.removeEventListener('pointermove', onMove);
          sash.removeEventListener('pointerup', onUp);
          sash.removeEventListener('pointercancel', onUp);
        };
      } else {
        document.addEventListener('pointermove', onMove);
        document.addEventListener('pointerup', onUp);
        document.addEventListener('pointercancel', onUp);
        detach = () => {
          document.removeEventListener('pointermove', onMove);
          document.removeEventListener('pointerup', onUp);
          document.removeEventListener('pointercancel', onUp);
        };
      }
      cleanupRef.current = detach;
    },
    [cssVar, store],
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
      const increments = event.shiftKey ? 4 : step;
      const sign = document.documentElement.getAttribute('dir') === 'rtl' ? -1 : 1;
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
    [cssVar, step, store, value],
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
