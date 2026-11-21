// The notice from the notch: a black pill that drops out of the notch when ANOMANDER's work ends,
// says so, and retracts into it. While the work goes on only the menu bar icon shows it. The shell
// owns the window and tells this page what to show (`src-tauri/src/notch.rs`); the page owns the
// motion (`notch.css`). One element, no React.

/** `Say` of `notch.rs`. */
export type Say = 'nothing' | 'done';

/**
 * `State` of `notch.rs`: `bar` is the menu bar's height the pill covers, 0 when it hangs under it;
 * `floating` is a screen with no notch or menu bar to hang from (Windows), where the pill floats
 * just below the top edge, rounded all round.
 */
export interface NoticeState {
  say: Say;
  bar: number;
  floating: boolean;
}

/**
 * The notice's words (es-ES). The mark says who; the label says what. "ANOMANDER ha terminado"
 * is wider than the pill, so the mark stands for the name.
 */
export const noticeText = {
  brand: 'ANOMANDER',
  done: 'Ha terminado',
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
  root.innerHTML = `<button class="pill" type="button" data-up="false" data-floating="false" aria-label="${noticeText.open}" style="--bar: 0px">
  <span class="pill-body">
    ${MARK}
    <span class="label" role="status" aria-live="polite"></span>
  </span>
</button>`;
  const pill = root.querySelector<HTMLButtonElement>('.pill');
  const label = root.querySelector<HTMLSpanElement>('.label');
  if (pill === null || label === null) throw new Error('the notice did not mount');
  pill.addEventListener('click', onOpen);

  return {
    show({ say, bar, floating }) {
      pill.style.setProperty('--bar', `${bar}px`);
      pill.dataset.floating = String(floating);
      if (say === 'nothing') {
        // The words stay while the pill retracts: it leaves saying what it said.
        pill.dataset.up = 'false';
        return;
      }
      label.textContent = noticeText[say];
      if (pill.dataset.up !== 'true') {
        // Painted once as a narrow drop at the notch, then up: so it grows, not jumps.
        pill.dataset.up = 'start';
        void pill.offsetWidth;
        pill.dataset.up = 'true';
      }
    },
  };
}
