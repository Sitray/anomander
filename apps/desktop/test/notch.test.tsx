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
    expect(pill.dataset['work']).toBe('idle');
    expect(label.textContent).toBe('');
    expect(pill.getAttribute('aria-label')).toBe(noticeText.open);
    expect(pill.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('ANOMANDER');
  });

  it('drops over the menu bar it is given when an answer is owed', () => {
    const { notice, pill, label } = mount();
    notice.show({ work: 'thinking', bar: 37 });
    expect(pill.dataset['up']).toBe('true');
    expect(pill.dataset['work']).toBe('thinking');
    expect(pill.style.getPropertyValue('--bar')).toBe('37px');
    expect(label.textContent).toBe('Pensando…');
  });

  it('says a task is a task', () => {
    const { notice, label } = mount();
    notice.show({ work: 'task', bar: 37 });
    expect(label.textContent).toBe('Haciendo una tarea…');
  });

  it('hangs from under a menu bar without a notch', () => {
    const { notice, pill } = mount();
    notice.show({ work: 'thinking', bar: 0 });
    expect(pill.style.getPropertyValue('--bar')).toBe('0px');
  });

  it('retracts when the work ends, keeping its last words while it does', () => {
    const { notice, pill, label } = mount();
    notice.show({ work: 'thinking', bar: 37 });
    notice.show({ work: 'idle', bar: 37 });
    expect(pill.dataset['up']).toBe('false');
    expect(label.textContent).toBe('Pensando…');
    // Work again: it drops again with the new words.
    notice.show({ work: 'task', bar: 37 });
    expect(pill.dataset['up']).toBe('true');
    expect(label.textContent).toBe('Haciendo una tarea…');
  });

  it('opens the chat on a click', () => {
    const { notice, onOpen, pill } = mount();
    notice.show({ work: 'thinking', bar: 37 });
    pill.click();
    expect(onOpen).toHaveBeenCalledTimes(1);
  });
});
