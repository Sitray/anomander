// The notch window's script: listens to the shell and draws the notice (`src-tauri/src/notch.rs`).
// The language first: every module after it reads text in the language it chose.
import '../locale.ts';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { mountNotice, type NoticeState } from './notice.ts';
import './notch.css';

/** `STATE_EVENT` of `notch.rs`. */
export const STATE_EVENT = 'notch://state';

const root = document.getElementById('root');
if (root === null) throw new Error('notch.html has no #root');

// A click asks for the app back, as the chat window does when its task is over (`reveal`).
const notice = mountNotice(root, () => {
  invoke('reveal').catch((error: unknown) => console.error('could not open the chat', error));
});

void listen<NoticeState>(STATE_EVENT, (event) => notice.show(event.payload));
