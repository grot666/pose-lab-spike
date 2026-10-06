/**
 * Start-screen lobby: create / join room, or continue single-device.
 * When `?role=&room=` is already set, shows room entry + connection status.
 */
import type { I18n } from '../core/i18n';
import {
  generateRoomCode,
  isValidRoomCode,
  normalizeRoomCode,
  parseRoomParams,
  roomUrl,
  type RoomRole,
} from '../core/roomCode';
import { $ } from './dom';

export type LobbySelection =
  | { kind: 'local' }
  | { kind: 'room'; role: RoomRole; room: string };

export class Lobby {
  private readonly lobby = $('#lobby');
  private readonly roomEntry = $('#room-entry');
  private readonly joinPanel = $('#lobby-join');
  private readonly codeInput = $('#lobby-code') as HTMLInputElement;
  private readonly roomStatus = $('#room-status');
  private readonly roomHints = $('#room-hints');
  private readonly roomConsent = $('#room-consent');
  private readonly roomBadge = $('#room-badge');
  private readonly roomStartBtn = $('#room-start-btn') as HTMLButtonElement;
  private readonly roomCopyBtn = $('#room-copy-btn') as HTMLButtonElement;
  private params: { role: RoomRole; room: string } | null;

  constructor(
    private i18n: I18n,
    private onLocalStart: () => void,
    private onRoomStart: () => void,
  ) {
    this.params = parseRoomParams(location.search);
    $('#lobby-create').addEventListener('click', () => this.createRoom());
    $('#lobby-join-toggle').addEventListener('click', () => {
      this.joinPanel.classList.toggle('hidden');
    });
    $('#lobby-join-go').addEventListener('click', () => this.joinRoom());
    this.codeInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinRoom();
    });
    $('#start-btn').addEventListener('click', () => this.onLocalStart());
    this.roomStartBtn.addEventListener('click', () => this.onRoomStart());
    this.roomCopyBtn.addEventListener('click', () => void this.copyViewerLink());

    // Placeholder via i18n (no native placeholder attr for data-i18n)
    document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = this.i18n.t(el.dataset.i18nPlaceholder!);
    });

    this.renderMode();
  }

  get roomParams(): { role: RoomRole; room: string } | null {
    return this.params;
  }

  private renderMode(): void {
    const inRoom = !!this.params;
    this.lobby.classList.toggle('hidden', inRoom);
    this.roomEntry.classList.toggle('hidden', !inRoom);
    this.roomConsent.classList.toggle('hidden', !inRoom);
    if (this.params) {
      this.roomBadge.textContent = this.i18n.t('room.badge', { code: this.params.room });
      this.roomBadge.classList.remove('hidden');
      this.roomBadge.dataset.role = this.params.role;
      this.roomHints.textContent = this.i18n.t(this.params.role === 'camera' ? 'room.camera_hint' : 'room.viewer_hint');
      this.roomStartBtn.textContent = this.i18n.t(this.params.role === 'camera' ? 'room.start_camera' : 'room.start_viewer');
      this.roomCopyBtn.classList.toggle('hidden', this.params.role !== 'camera');
      this.setStatus(this.i18n.t('room.connecting', { code: this.params.room }));
    } else {
      this.roomBadge.classList.add('hidden');
    }
  }

  reapplyI18n(): void {
    document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]').forEach((el) => {
      el.placeholder = this.i18n.t(el.dataset.i18nPlaceholder!);
    });
    if (this.params) {
      this.roomBadge.textContent = this.i18n.t('room.badge', { code: this.params.room });
      this.roomHints.textContent = this.i18n.t(this.params.role === 'camera' ? 'room.camera_hint' : 'room.viewer_hint');
      this.roomStartBtn.textContent = this.i18n.t(this.params.role === 'camera' ? 'room.start_camera' : 'room.start_viewer');
    }
  }

  setStatus(text: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info'): void {
    this.roomStatus.textContent = text;
    this.roomStatus.dataset.kind = kind;
  }

  setStartEnabled(enabled: boolean): void {
    this.roomStartBtn.disabled = !enabled;
  }

  private createRoom(): void {
    const code = generateRoomCode();
    // Creating from a phone → camera; from desktop → still let user pick via join, but create defaults to camera host
    const role: RoomRole = 'camera';
    location.assign(roomUrl(role, code));
  }

  private joinRoom(): void {
    const code = normalizeRoomCode(this.codeInput.value);
    if (!isValidRoomCode(code)) {
      this.codeInput.setCustomValidity(this.i18n.t('room.code_placeholder'));
      this.codeInput.reportValidity();
      return;
    }
    this.codeInput.setCustomValidity('');
    const roleEl = document.querySelector<HTMLInputElement>('input[name="lobby-role"]:checked');
    const role = (roleEl?.value === 'camera' ? 'camera' : 'viewer') as RoomRole;
    location.assign(roomUrl(role, code));
  }

  private async copyViewerLink(): Promise<void> {
    if (!this.params) return;
    const url = roomUrl('viewer', this.params.room);
    try {
      await navigator.clipboard.writeText(url);
      const prev = this.roomCopyBtn.textContent;
      this.roomCopyBtn.textContent = this.i18n.t('room.copied');
      setTimeout(() => {
        this.roomCopyBtn.textContent = prev;
      }, 1200);
    } catch {
      prompt(this.i18n.t('room.copy_link'), url);
    }
  }
}
