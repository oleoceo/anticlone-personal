const apiRoot = '/admin/ui/';
type Bootstrap = {authenticated: boolean; csrf: string};

export class AdminError extends Error {
  constructor(readonly status: number) {
    super('Falha da API administrativa');
  }
}

export function errorMessage(error: unknown): string {
  const status = error instanceof AdminError ? error.status : 0;
  switch (status) {
    case 400: return 'O servidor recusou os dados ou a operação. Confira os campos e a configuração atual.';
    case 401: return 'Sua sessão terminou. Entre novamente.';
    case 403: return 'A solicitação não foi autorizada. Confira sua sessão e tente novamente.';
    case 409: return 'Os dados entraram em conflito com o estado atual. Confira o cadastro antes de continuar.';
    case 413: return 'Os dados excedem o tamanho aceito pelo servidor.';
    default: return 'Não foi possível concluir a solicitação. Confira a conexão ou consulte o estado atual.';
  }
}

export class AdminApi {
  private session: Bootstrap | undefined;
  private generation = 0;
  private pending: Promise<Bootstrap> | undefined;

  constructor(private readonly onSession: (authenticated: boolean) => void) {}

  refresh() {
    if (!this.pending) {
      const generation = this.generation;
      const pending = this.send<Bootstrap>('bootstrap').then(session => {
        if (generation === this.generation) {
          this.session = session;
          this.onSession(session.authenticated);
        }
        return session;
      }).finally(() => {
        if (this.pending === pending) this.pending = undefined;
      });
      this.pending = pending;
    }
    return this.pending;
  }

  async login(password: string, code: string) {
    // An anonymous bootstrap in another tab can replace the login CSRF cookie.
    if ((await this.refresh()).authenticated) return;
    await this.request('login', {password, code});
    this.resetSession();
    await this.refresh();
  }

  async logout() {
    await this.request('logout', {});
    this.resetSession();
    this.onSession(false);
    await this.refresh().catch(() => undefined);
  }

  private resetSession() {
    this.generation++;
    this.pending = undefined;
    this.session = undefined;
  }

  createProject(name: string, origin: string, intent: string) {
    return this.request<Project>('project-create', {name, origin}, undefined, intent);
  }

  async request<T>(path: string, body?: object, signal?: AbortSignal, intent?: string): Promise<T> {
    try {
      return await this.send<T>(path, body, signal, intent);
    } catch (error) {
      if (error instanceof AdminError && [401, 403].includes(error.status)) {
        // The existing server can return 403 before checking session expiry.
        // Refresh the session, but never replay the original command.
        await this.refresh().catch(() => undefined);
      }
      throw error;
    }
  }

  private async send<T>(path: string, body?: object, signal?: AbortSignal, intent?: string): Promise<T> {
    const response = await fetch(apiRoot + path, {
      credentials: 'same-origin', cache: 'no-store', signal,
      ...(body === undefined ? {} : {
        method: 'POST',
        headers: {
        'Content-Type': 'application/json', 'X-CSRF-Token': this.session?.csrf ?? '',
        ...(intent ? {'Idempotency-Key': intent} : {}),
      },
        body: JSON.stringify(body),
      }),
    });
    if (!response.ok) throw new AdminError(response.status);
    return response.status === 204 ? undefined as T : response.json() as Promise<T>;
  }
}

export type Project = {id: string; name: string};
export type PageUrl = {origin: string; pathname: string};
export type Page = {id: string; project_id: string; name: string; enabled: boolean; urls: PageUrl[]};
export type ProjectState = {state: string; pages: {id: string; lifecycle_state: string}[]};
export type ProjectHistory = {registration: {project_id: string; name: string; origin: string}[]};

export const pageList = (api: AdminApi, project: string, signal?: AbortSignal) =>
  api.request<{pages: Page[]}>('pages', {action: 'list', project}, signal);
