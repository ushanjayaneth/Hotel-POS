import { useEffect, useRef, type ReactNode, type RefObject } from "react";
import { X, LoaderCircle, Inbox } from "lucide-react";
import {createPortal} from 'react-dom';
import {useBackLayer} from '../lib/navigation';

const touchDialog = () => window.matchMedia('(pointer: coarse)').matches;

/** Keep the keyboard closed until a touchscreen user chooses a field. */
export function focusDialog(dialog: HTMLElement | null) {
  if (!dialog) return;
  const target = touchDialog() ? dialog : dialog.querySelector<HTMLElement>(
    'input:not([disabled]):not([type="hidden"]),textarea:not([disabled]),select:not([disabled])',
  ) ?? dialog.querySelector<HTMLElement>('button:not([disabled])') ?? dialog;
  target.focus({preventScroll: true});
}

export function restoreDialogFocus(previous: HTMLElement | null) {
  if (!previous?.isConnected) return;
  if (touchDialog() && previous.matches('input,select,textarea,[contenteditable="true"]')) return;
  previous.focus({preventScroll: true});
}

/** Mobile keyboards resize the visual viewport, not every browser's layout viewport. */
export function useDialogViewport(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const viewport = window.visualViewport;
    const backdrop = ref.current?.closest<HTMLElement>('.modal-backdrop');
    if (!viewport || !backdrop) return;
    const update = () => {
      backdrop.style.setProperty('--dialog-viewport-height', `${viewport.height}px`);
      backdrop.style.top = `${viewport.offsetTop}px`;
      backdrop.style.height = `${viewport.height}px`;
      backdrop.style.bottom = 'auto';
    };
    update();
    viewport.addEventListener('resize', update, {passive: true});
    viewport.addEventListener('scroll', update, {passive: true});
    return () => {
      viewport.removeEventListener('resize', update);
      viewport.removeEventListener('scroll', update);
    };
  }, [ref]);
}

let scrollLockCount=0;
let originalBodyOverflow='';
/** Nested dialogs release the page only when the last dialog closes. */
export function useBodyScrollLock(){
  useEffect(()=>{
    if(scrollLockCount++===0){originalBodyOverflow=document.body.style.overflow;document.body.style.overflow='hidden';}
    return()=>{if(--scrollLockCount===0)document.body.style.overflow=originalBodyOverflow;};
  },[]);
}

export function Modal({
  title,
  subtitle,
  children,
  onClose,
  wide = false,
}: {
  title: string;
  subtitle?: string;
  children: ReactNode;
  onClose: () => void;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useBackLayer(true,onClose,`dialog-${title}`);
  useDialogViewport(ref);
  useBodyScrollLock();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {e.preventDefault();closeRef.current();}
      if (e.key === "Tab") {
        const items = ref.current?.querySelectorAll<HTMLElement>(
          'button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex="0"]',
        );
        if (!items?.length) return;
        const first = items[0],
          last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener("keydown", handler);
    focusDialog(ref.current);
    return () => {
      document.removeEventListener("keydown", handler);
      restoreDialogFocus(previous);
    };
  }, []);
  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div
        className={`modal ${wide ? "modal-wide" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        ref={ref}
      >
        <div className="modal-header">
          <div>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X size={20} />
          </button>
        </div>
        {children}
      </div>
    </div>, document.body
  );
}
export function Spinner({ label = "Loading workspace" }: { label?: string }) {
  return (
    <div className="loading-state">
      <LoaderCircle className="spin" size={26} />
      <span>{label}</span>
    </div>
  );
}
export function EmptyState({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children?: ReactNode;
}) {
  return (
    <div className="empty-state">
      <div className="empty-icon">
        <Inbox size={28} />
      </div>
      <h3>{title}</h3>
      <p>{description}</p>
      {children}
    </div>
  );
}
export function StatusBadge({ status }: { status: string }) {
  const label = status.replaceAll("-", " ");
  return <span className={`badge status-${status}`}>{label}</span>;
}
