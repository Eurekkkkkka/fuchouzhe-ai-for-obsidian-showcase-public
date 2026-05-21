export interface WhitelistCheckResult {
	valid: boolean;
	authType?: 'BASIC' | 'PRO';
	phone?: string;
	message?: string;
	error?: string;
	sessionToken?: string;
	expiresAt?: string;
}

export interface LoginStatusResult {
	authorized: boolean;
	passwordSet?: boolean;
	authType?: 'BASIC' | 'PRO';
	message?: string;
	error?: string;
}

const DEMO_PHONE = 'demo-user';
const DEMO_SESSION = 'public-showcase-session';

export class AuthService {
	async verifyLogin(): Promise<WhitelistCheckResult> {
		return this.createDemoSession();
	}

	async getLoginStatus(): Promise<LoginStatusResult> {
		return {
			authorized: true,
			passwordSet: true,
			authType: 'BASIC',
			message: 'Public showcase demo mode'
		};
	}

	async setupPassword(): Promise<WhitelistCheckResult> {
		return this.createDemoSession();
	}

	async changePassword(): Promise<{ success: boolean; message?: string; error?: string }> {
		return {
			success: true,
			message: 'Public showcase demo mode does not use passwords.'
		};
	}

	async verifyCurrentSession(): Promise<WhitelistCheckResult> {
		return this.createDemoSession();
	}

	async checkLocal(): Promise<{ loggedIn: boolean; phone: string; error?: string }> {
		this.ensureDemoStorage();
		return { loggedIn: true, phone: DEMO_PHONE };
	}

	isLoggedIn(): boolean {
		this.ensureDemoStorage();
		return true;
	}

	getAuthType(): 'BASIC' | 'PRO' {
		return 'BASIC';
	}

	logout(): void {
		this.ensureDemoStorage();
	}

	getCurrentPhone(): string {
		return DEMO_PHONE;
	}

	private createDemoSession(): WhitelistCheckResult {
		this.ensureDemoStorage();
		return {
			valid: true,
			authType: 'BASIC',
			phone: DEMO_PHONE,
			sessionToken: DEMO_SESSION,
			message: 'Public showcase demo mode'
		};
	}

	private ensureDemoStorage(): void {
		localStorage.setItem('fuchou_showcase_mode', 'public-demo');
		localStorage.setItem('fuchou_phone', DEMO_PHONE);
		localStorage.setItem('fuchou_session_token', DEMO_SESSION);
		localStorage.setItem('fuchou_auth_type', 'BASIC');
	}
}

export const authService = new AuthService();
