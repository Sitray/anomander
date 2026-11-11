// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConnectionsScreen } from '../src/connections/ConnectionsScreen.tsx';
import type { ConnectionInput, ConnectionsView } from '../src/shell.ts';
import { strings } from '../src/strings.ts';
import { CONNECTIONS, NO_CONNECTIONS } from './fixtures.ts';

// DK-11: the connections screen. A value goes in and never comes back out.
afterEach(cleanup);

const { connections: text } = strings;
const SECRET = 'typed-secret-value-9';

const renderScreen = async (
  view: ConnectionsView = CONNECTIONS,
  save: (server: ConnectionInput) => Promise<ConnectionsView> = async () => view,
) => {
  const load = vi.fn(async () => view);
  const onSave = vi.fn(save);
  const onRemove = vi.fn(async (_name: string) => NO_CONNECTIONS);
  const onClose = vi.fn();
  render(<ConnectionsScreen load={load} onSave={onSave} onRemove={onRemove} onClose={onClose} />);
  await waitFor(() => expect(screen.queryByText(text.loading)).toBeNull());
  return { load, onSave, onRemove, onClose };
};

const field = (label: string): HTMLInputElement => screen.getByLabelText(label);
const fill = (label: string, value: string): void => {
  fireEvent.change(field(label), { target: { value } });
};
const click = (name: string): void => {
  fireEvent.click(screen.getByRole('button', { name }));
};
const saved = async (onSave: ReturnType<typeof vi.fn>): Promise<ConnectionInput> => {
  await waitFor(() => expect(onSave).toHaveBeenCalledOnce());
  return onSave.mock.calls[0]?.[0] as ConnectionInput;
};
const servers = () => screen.getByRole('list', { name: text.servers });
/** Nothing on screen holds the value: no text, no attribute, no field. */
const nowhere = (secret: string): void => {
  expect(document.body.innerHTML).not.toContain(secret);
  for (const input of document.querySelectorAll('input, textarea')) {
    expect((input as HTMLInputElement).value).not.toBe(secret);
  }
};

describe('what it shows', () => {
  it('lists the servers of the file with how each is reached', async () => {
    await renderScreen();

    const rows = within(servers()).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining('notesnpx -y notes-mcp'),
      expect.stringContaining('remotehttps://example.com/mcp'),
    ]);
  });

  it('says so when there is none', async () => {
    await renderScreen(NO_CONNECTIONS);

    expect(screen.getByText(text.none)).toBeTruthy();
    expect(screen.getByRole('button', { name: text.add })).toBeTruthy();
  });

  it('says a file the daemon would not read is so, and offers no change', async () => {
    const where = 'mcp.json is not as the daemon reads it: mcpServers.notes.type';
    await renderScreen({ servers: [], invalid: where });

    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(text.invalid);
    expect(alert.textContent).toContain(where);
    expect(screen.queryByRole('button', { name: text.add })).toBeNull();
    expect(screen.queryByText(text.none)).toBeNull();
  });

  it('says when the shell could not read them, and reads again when asked', async () => {
    const load = vi
      .fn<() => Promise<ConnectionsView>>()
      .mockRejectedValueOnce('the shell failed: channel closed')
      .mockResolvedValue(CONNECTIONS);
    render(<ConnectionsScreen load={load} onSave={vi.fn()} onRemove={vi.fn()} onClose={vi.fn()} />);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.loadFailed);
    expect(alert.textContent).toContain('the shell failed: channel closed');

    click(strings.status.retry);
    await waitFor(() => expect(servers()).toBeTruthy());
  });

  it('closes on its button and on Escape', async () => {
    const { onClose } = await renderScreen();
    click(text.close);
    fireEvent.keyDown(servers(), { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(2);
  });
});

describe('adding a server', () => {
  it('sends a program with its arguments, its values and its read-only tools', async () => {
    const after: ConnectionsView = {
      servers: [
        {
          name: 'files',
          kind: 'process',
          command: 'npx',
          args: ['-y', 'files-mcp'],
          values: [{ name: 'API_KEY', stored: true }],
          readOnly: ['list', 'read'],
        },
      ],
      invalid: null,
    };
    const { onSave } = await renderScreen(NO_CONNECTIONS, async () => after);
    click(text.add);
    fill(text.name, ' files ');
    fill(text.command, 'npx');
    fill(text.args, '-y\nfiles-mcp\n');
    fill(text.envName, 'API_KEY');
    fill(text.value, SECRET);
    click(text.addValue);
    fill(text.readOnly, 'list\n\n read ');

    // Added, and already out of its field.
    expect(field(text.value).value).toBe('');
    expect(field(text.value).type).toBe('password');
    expect(screen.getByText(text.valueNew)).toBeTruthy();
    nowhere(SECRET);
    click(text.save);

    expect(await saved(onSave)).toEqual({
      name: 'files',
      kind: 'process',
      command: 'npx',
      args: ['-y', 'files-mcp'],
      values: [{ name: 'API_KEY', value: SECRET }],
      readOnly: ['list', 'read'],
    });
    // Back to the list, as the shell now has it.
    await waitFor(() => expect(servers().textContent).toContain('filesnpx -y files-mcp'));
    nowhere(SECRET);
  });

  it('sends a server over HTTP, with a header typed and not added', async () => {
    const { onSave } = await renderScreen(NO_CONNECTIONS);
    click(text.add);
    fill(text.name, 'remote');
    fill(text.kind, 'http');
    fill(text.url, 'https://example.com/mcp');
    fill(text.headerName, 'Authorization');
    fill(text.value, `  ${SECRET} `);
    click(text.save);

    expect(await saved(onSave)).toEqual({
      name: 'remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      values: [{ name: 'Authorization', value: SECRET }],
      readOnly: [],
    });
  });

  it('explains what the daemon would refuse, and saves nothing', async () => {
    const { onSave } = await renderScreen();
    click(text.add);
    fill(text.name, '_notes');
    click(text.save);
    expect(screen.getByText(text.nameInvalid)).toBeTruthy();
    expect(screen.getByText(text.commandMissing)).toBeTruthy();
    expect(field(text.name).getAttribute('aria-invalid')).toBe('true');
    expect(screen.getByText(strings.setup.fixFields)).toBeTruthy();

    // The name of another server.
    fill(text.name, 'notes');
    fill(text.command, 'npx');
    click(text.save);
    expect(screen.getByText(text.nameTaken)).toBeTruthy();
    expect(screen.queryByText(text.commandMissing)).toBeNull();

    fill(text.name, 'other');
    fill(text.kind, 'http');
    for (const url of ['', 'example.com/mcp', 'http://example.com/mcp', 'ftp://localhost/mcp']) {
      fill(text.url, url);
      click(text.save);
      expect(screen.getByText(text.urlInvalid), url).toBeTruthy();
    }

    // A value needs its name, and a new name its value.
    fill(text.url, 'http://localhost:3000/mcp');
    fill(text.value, SECRET);
    click(text.save);
    expect(screen.getByText(text.valueNameMissing)).toBeTruthy();
    fill(text.value, '');
    fill(text.headerName, 'Authorization');
    click(text.addValue);
    expect(screen.getByText(text.valueMissing)).toBeTruthy();

    expect(onSave).not.toHaveBeenCalled();
  });

  it('shows what the shell says when it refuses, and never the value', async () => {
    const { onSave } = await renderScreen(NO_CONNECTIONS, async () => {
      throw 'could not store mcp/files/env/API_KEY in the Keychain (status -25293)';
    });
    click(text.add);
    fill(text.name, 'files');
    fill(text.command, 'npx');
    fill(text.envName, 'API_KEY');
    fill(text.value, SECRET);
    click(text.save);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(strings.setup.rejected);
    expect(alert.textContent).toContain('could not store mcp/files/env/API_KEY');
    nowhere(SECRET);

    // Still in the form, and saving again sends the value again.
    click(text.save);
    await waitFor(() => expect(onSave).toHaveBeenCalledTimes(2));
    expect(onSave.mock.calls[1]?.[0]).toMatchObject({
      values: [{ name: 'API_KEY', value: SECRET }],
    });
  });

  it('goes back to the list without saving', async () => {
    const { onSave, onClose } = await renderScreen();
    click(text.add);
    fill(text.name, 'other');
    click(text.cancel);

    expect(servers()).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});

describe('editing a server', () => {
  it('shows what the file holds, and of a value only its name and that it is stored', async () => {
    await renderScreen();
    click(text.editServer('notes'));

    expect(screen.getByRole('heading', { name: text.editTitle('notes') })).toBeTruthy();
    expect(field(text.name).value).toBe('notes');
    expect(field(text.command).value).toBe('npx');
    expect(field(text.args).value).toBe('-y\nnotes-mcp');
    expect(field(text.readOnly).value).toBe('search');
    expect(field(text.value).value).toBe('');
    const values = within(screen.getByRole('list', { name: text.env }))
      .getAllByRole('listitem')
      .map((row) => row.textContent);
    expect(values).toEqual([
      expect.stringContaining(`API_KEY${text.valueStored}`),
      expect.stringContaining(`DEBUG${text.valueEmpty}`),
    ]);
  });

  it('keeps a value by its name alone, replaces one typed again and drops one removed', async () => {
    const { onSave } = await renderScreen();
    click(text.editServer('notes'));
    fill(text.name, 'my notes');
    click(text.removeValue('DEBUG'));
    expect(screen.getByText(text.valueRemoved)).toBeTruthy();
    fill(text.envName, 'REGION');
    fill(text.value, 'eu-west-1');
    click(text.addValue);
    click(text.save);

    expect(await saved(onSave)).toEqual({
      original: 'notes',
      name: 'my notes',
      kind: 'process',
      command: 'npx',
      args: ['-y', 'notes-mcp'],
      values: [{ name: 'API_KEY' }, { name: 'REGION', value: 'eu-west-1' }],
      readOnly: ['search'],
    });
  });

  it('replaces a stored value typed under its name, until that is undone', async () => {
    const { onSave } = await renderScreen();
    click(text.editServer('remote'));
    fill(text.headerName, 'Authorization');
    fill(text.value, SECRET);
    click(text.addValue);
    expect(screen.getByText(text.valueReplaced)).toBeTruthy();
    click(text.undoValueChange('Authorization'));
    expect(screen.getByText(text.valueStored)).toBeTruthy();
    click(text.save);

    expect(await saved(onSave)).toEqual({
      original: 'remote',
      name: 'remote',
      kind: 'http',
      url: 'https://example.com/mcp',
      values: [{ name: 'Authorization' }],
      readOnly: [],
    });
  });
});

describe('removing a server', () => {
  it('asks first, and does nothing when the answer is no', async () => {
    const { onRemove } = await renderScreen();
    click(text.removeServer('notes'));
    expect(screen.getByText(text.confirmRemove('notes'))).toBeTruthy();
    click(text.keepServer);

    expect(screen.queryByText(text.confirmRemove('notes'))).toBeNull();
    expect(onRemove).not.toHaveBeenCalled();
  });

  it('removes it through the shell and shows what is left', async () => {
    const { onRemove } = await renderScreen();
    click(text.removeServer('notes'));
    click(text.confirmRemoveYes);

    await waitFor(() => expect(screen.getByText(text.none)).toBeTruthy());
    expect(onRemove).toHaveBeenCalledExactlyOnceWith('notes');
  });

  it('shows what the shell says when it refuses', async () => {
    const { onRemove } = await renderScreen();
    onRemove.mockRejectedValue('mcp.json changed meanwhile: nothing was saved');
    click(text.removeServer('remote'));
    click(text.confirmRemoveYes);

    const alert = await screen.findByRole('alert');
    expect(alert.textContent).toContain(text.removeRejected);
    expect(alert.textContent).toContain('mcp.json changed meanwhile');
    expect(servers().textContent).toContain('remote');
  });
});
