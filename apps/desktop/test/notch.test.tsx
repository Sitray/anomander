// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mountNotice, noticeText } from '../src/notch/notice.ts';

// The notice from the notch: what the page shows for each state the shell sends it.
describe('the notice from the notch', () => {
  const mount = () => {
    const root = document.createElement('div');
    document.body.append(root);
    const onOpen = vi.fn();
    const notice = mountNotice(root, onOpen);
    const pill = root.querySelector<HTMLButtonElement>('.pill');
    const label = root.querySelector<HTMLElement>('[role="status"]');
    if (pill === null || label === null) throw new Error('no pill');
    return { notice, onOpen, pill, label };
  };

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('starts retracted into the notch, saying nothing yet', () => {
    const { pill, label } = mount();
    expect(pill.dataset['up']).toBe('false');
    expect(label.textContent).toBe('');
    expect(pill.getAttribute('aria-label')).toBe(noticeText.open);
    expect(pill.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('ANOMANDER');
  });

  it('drops over the menu bar it is given to say the work has ended', () => {
    const { notice, pill, label } = mount();
    notice.show({ say: 'done', bar: 37, floating: false });
    expect(pill.dataset['up']).toBe('true');
    expect(pill.style.getPropertyValue('--bar')).toBe('37px');
    expect(label.textContent).toBe('Ha terminado');
  });

  it('shows nothing of the work itself: the menu bar icon does that', () => {
    const { pill } = mount();
    expect(pill.querySelector('.wave')).toBeNull();
    expect(Object.values(noticeText)).not.toContain('Pensando…');
  });

  it('hangs from under a menu bar without a notch', () => {
    const { notice, pill } = mount();
    notice.show({ say: 'done', bar: 0, floating: false });
    expect(pill.style.getPropertyValue('--bar')).toBe('0px');
  });

  it('floats, rounded, where there is no notch or menu bar to hang from', () => {
    const { notice, pill } = mount();
    expect(pill.dataset['floating']).toBe('false');
    notice.show({ say: 'done', bar: 0, floating: true });
    expect(pill.dataset['floating']).toBe('true');
    expect(pill.dataset['up']).toBe('true');
    expect(pill.style.getPropertyValue('--bar')).toBe('0px');
  });

  it('retracts when told to say nothing, keeping its words while it does', () => {
    const { notice, pill, label } = mount();
    notice.show({ say: 'done', bar: 37, floating: false });
    notice.show({ say: 'nothing', bar: 37, floating: false });
    expect(pill.dataset['up']).toBe('false');
    expect(label.textContent).toBe('Ha terminado');
    // The next end drops it again.
    notice.show({ say: 'done', bar: 37, floating: false });
    expect(pill.dataset['up']).toBe('true');
  });

  it('opens the chat on a click', () => {
    const { notice, onOpen, pill } = mount();
    notice.show({ say: 'done', bar: 37, floating: false });
    pill.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
