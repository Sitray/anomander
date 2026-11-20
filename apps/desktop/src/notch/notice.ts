// The notice from the notch: a black pill that grows out of the notch while ANOMANDER works and
// retracts into it when the work ends. The shell owns the window and tells this page what to show
// (`src-tauri/src/notch.rs`); the page owns the motion (`notch.css`). One element, no React.

/** `Work` of `notch.rs`. */
export type Work = 'idle' | 'thinking' | 'task';

/** `State` of `notch.rs`: `bar` is the menu bar's height the pill covers, 0 when it hangs under it. */
export interface NoticeState {
  work: Work;
  bar: number;
}

/** The notice's words (es-ES). The mark says who; the label says what. */
export const noticeText = {
  brand: 'ANOMANDER',
  thinking: 'Pensando…',
  task: 'Haciendo una tarea…',
  open: 'Abrir el chat de ANOMANDER',
} as const;

export interface Notice {
  show(state: NoticeState): void;
}

const MARK = `<svg class="mark" viewBox="0 0 16 16" width="14" height="14" role="img" aria-label="${noticeText.brand}" focusable="false">
  <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="2" />
  <circle cx="8" cy="8" r="2.5" fill="currentColor" />
</svg>`;

/**
 * Mounts the pill in `root`, retracted. `onOpen` runs when the principal clicks it: the window
 * takes no focus, so a click is the only input it ever gets.
 */
export function mountNotice(root: HTMLElement, onOpen: () => void): Notice {
  root.innerHTML = `<button class="pill" type="button" data-up="false" data-work="idle" aria-label="${noticeText.open}" style="--bar: 0px">
  <span class="pill-body">
    ${MARK}
    <span class="wave" aria-hidden="true"><i></i><i></i><i></i></span>
    <span class="label" role="status" aria-live="polite"></span>
  </span>
</button>`;
  const pill = root.querySelector<HTMLButtonElement>('.pill');
  const label = root.querySelector<HTMLSpanElement>('.label');
  if (pill === null || label === null) throw new Error('the notice did not mount');
  pill.addEventListener('click', onOpen);

  return {
    show({ work, bar }) {
      pill.style.setProperty('--bar', `${bar}px`);
      if (work === 'idle') {
        // The words stay while the pill retracts: it leaves saying what it was doing.
        pill.dataset['up'] = 'false';
        return;
      }
      label.textContent = noticeText[work];
      pill.dataset['work'] = work;
      if (pill.dataset['up'] !== 'true') {
        // Painted once at rest, then up: so the drop is a transition, not a jump.
        void pill.offsetWidth;
        pill.dataset['up'] = 'true';
      }
    },
  };
}
