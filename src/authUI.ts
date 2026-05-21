import { Notice } from 'obsidian';
import { authService } from './authService';

export interface AuthUIOptions {
	container: HTMLElement;
	onSuccess: () => void;
	onLogout: () => void;
}

export class AuthUI {
	private container: HTMLElement;
	private onSuccess: () => void;
	private loggedIn = true;

	constructor(options: AuthUIOptions) {
		this.container = options.container;
		this.onSuccess = options.onSuccess;
	}

	async init(): Promise<void> {
		await authService.checkLocal();
		this.loggedIn = true;
		this.renderDemoMode();
		this.onSuccess();
	}

	async ensureSession(): Promise<boolean> {
		await authService.verifyCurrentSession();
		this.loggedIn = true;
		return true;
	}

	isLoggedIn(): boolean {
		return this.loggedIn;
	}

	logout(): void {
		authService.logout();
		this.loggedIn = true;
		new Notice('公开展示版已启用 Demo 模式，无需登录。');
		this.onSuccess();
	}

	private renderDemoMode(): void {
		this.container.empty();
		const card = this.container.createDiv({ cls: 'fuchou-auth-container' });
		card.createEl('div', {
			text: 'Public Showcase Demo',
			cls: 'fuchou-auth-title'
		});
		card.createEl('div', {
			text: '本公开版已移除商业授权和手机号登录，安装后可直接体验插件主体能力。',
			cls: 'fuchou-auth-subtitle'
		});
	}
}
