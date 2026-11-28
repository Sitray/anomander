// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SetupScreen } from '../src/setup/SetupScreen.tsx';
import type { SetupState } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { EMPTY_SETUP, FILLED_SETUP } from './fixtures.ts';

// B64 (DK-23 AC2): "Otro modelo…" chosen in the picker stays chosen and leaves "Modelo" to write;
// "Modelo para fotos" goes with it only when it just followed the model.
afterEach(cleanup);

const { setup: text } = strings;

const renderSetup = (setup: SetupState) => {
  render(<SetupScreen setup={setup} onSave={vi.fn(async () => FILLED_SETUP)} onClose={vi.fn()} />);
};

const field = (label: string): HTMLInputElement => screen.getByLabelText(label);
const picker = (): HTMLSelectElement => screen.getByLabelText(text.modelProvider);
const pick = (value: string): void => {
  fireEvent.change(picker(), { target: { value } });
};
/** The picker, "Modelo" and "Modelo para fotos", as the screen shows them. */
const shown = () => ({
  picker: picker().value,
  model: field(text.model).value,
  vision: field(text.visionModel).value,
});

describe('"Otro modelo…" and the photo model (B64)', () => {
  it('chosen on an empty setup, leaves both models to write', () => {
    renderSetup(EMPTY_SETUP);
    pick('other');

    expect(shown()).toEqual({ picker: 'other', model: '', vision: '' });
  });

  it('chosen on a saved setup, keeps a photo model that differs from the model', () => {
    renderSetup({ ...FILLED_SETUP, visionModel: 'google/gemini-2.5-flash' });
    pick('other');

    expect(shown()).toEqual({ picker: 'other', model: '', vision: 'google/gemini-2.5-flash' });
  });

  it('chosen on a saved setup, takes the photo model that is the model with it', () => {
    renderSetup(FILLED_SETUP);
    expect(shown().vision).toBe(shown().model);
    pick('other');

    expect(shown()).toEqual({ picker: 'other', model: '', vision: '' });
  });

  it('chosen after a model typed with a listed provider, stays chosen', () => {
    renderSetup(EMPTY_SETUP);
    fireEvent.change(field(text.model), { target: { value: 'google/gemini-2.5-pro' } });
    expect(shown().picker).toBe('google');
    pick('other');

    expect(shown()).toEqual({ picker: 'other', model: '', vision: '' });
  });

  it('chosen twice, stays chosen; a provider then fills both models with its suggestion', () => {
    renderSetup(EMPTY_SETUP);
    pick('google');
    pick('other');
    pick('other');
    expect(shown()).toEqual({ picker: 'other', model: '', vision: '' });

    pick('openai');

    expect(shown()).toEqual({
      picker: 'openai',
      model: 'openai/gpt-5-mini',
      vision: 'openai/gpt-5-mini',
    });
  });
});
