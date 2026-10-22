export interface RenderService {
  id: string;
  name: string;
  type?: string;
  serviceDetails?: Record<string, unknown>;
}

export interface RenderDeploy {
  id: string;
  status: string;
  createdAt?: string;
}

export interface DeployProvider {
  listServices(): Promise<RenderService[]>;
  getService(serviceId: string): Promise<RenderService>;
  triggerDeploy(serviceId: string): Promise<RenderDeploy>;
  deployStatus(serviceId: string): Promise<RenderDeploy | null>;
}

type FetchLike = typeof fetch;

function asService(value: unknown): RenderService {
  const outer = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const row = outer.service && typeof outer.service === "object" ? outer.service as Record<string, unknown> : outer;
  if (typeof row.id !== "string" || typeof row.name !== "string") throw new Error("Render returned an invalid service");
  return { id: row.id, name: row.name, ...(typeof row.type === "string" ? { type: row.type } : {}) };
}

function asDeploy(value: unknown): RenderDeploy {
  const row = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (typeof row.id !== "string" || typeof row.status !== "string") throw new Error("Render returned an invalid deploy");
  return { id: row.id, status: row.status, ...(typeof row.createdAt === "string" ? { createdAt: row.createdAt } : {}) };
}

export class RenderProvider implements DeployProvider {
  constructor(
    private readonly apiKey: string,
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly fetcher: FetchLike = fetch,
    private readonly baseUrl = "https://api.render.com/v1"
  ) {}

  async listServices(): Promise<RenderService[]> {
    const value = await this.request("/services?limit=20");
    if (!Array.isArray(value)) throw new Error("Render returned an invalid service list");
    return value.map(asService);
  }

  async getService(serviceId: string): Promise<RenderService> {
    return asService(await this.request(`/services/${encodeURIComponent(serviceId)}`));
  }

  async triggerDeploy(serviceId: string): Promise<RenderDeploy> {
    if (!this.env.PIXIE_RENDER_SERVICE_ID || this.env.PIXIE_RENDER_SERVICE_ID !== serviceId) {
      throw new Error("PIXIE_RENDER_SERVICE_ID must identify the selected runtime service");
    }
    if (this.env.PIXIE_ALLOW_RENDER_DEPLOY !== "1") {
      throw new Error("PIXIE_ALLOW_RENDER_DEPLOY=1 is required to deploy the runtime");
    }
    await this.getService(serviceId);
    return asDeploy(await this.request(`/services/${encodeURIComponent(serviceId)}/deploys`, {
      method: "POST",
      body: "{}"
    }));
  }

  async deployStatus(serviceId: string): Promise<RenderDeploy | null> {
    const value = await this.request(`/services/${encodeURIComponent(serviceId)}/deploys?limit=1`);
    if (!Array.isArray(value)) throw new Error("Render returned an invalid deploy list");
    return value.length ? asDeploy(value[0]) : null;
  }

  private async request(path: string, init: RequestInit = {}): Promise<unknown> {
    if (!this.apiKey) throw new Error("RENDER_API_KEY is required");
    const response = await this.fetcher(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        ...(init.body ? { "content-type": "application/json" } : {}),
        ...init.headers
      }
    });
    if (!response.ok) throw new Error(`Render API request failed with HTTP ${response.status}`);
    return response.status === 204 ? null : response.json();
  }
}

export class MockRenderProvider implements DeployProvider {
  readonly calls: string[] = [];
  readonly services: RenderService[];
  readonly deploys = new Map<string, RenderDeploy>();

  constructor(
    services: RenderService[] = [{ id: "srv-runtime", name: "pixie-runtime", type: "web_service" }],
    private readonly env: Record<string, string | undefined> = process.env
  ) {
    this.services = structuredClone(services);
  }

  async listServices() {
    this.calls.push("listServices");
    return structuredClone(this.services);
  }

  async getService(serviceId: string) {
    this.calls.push(`getService:${serviceId}`);
    const service = this.services.find((item) => item.id === serviceId);
    if (!service) throw new Error("Render service not found");
    return structuredClone(service);
  }

  async triggerDeploy(serviceId: string) {
    this.calls.push(`triggerDeploy:${serviceId}`);
    if (this.env.PIXIE_RENDER_SERVICE_ID !== serviceId) throw new Error("PIXIE_RENDER_SERVICE_ID must identify the selected runtime service");
    if (this.env.PIXIE_ALLOW_RENDER_DEPLOY !== "1") throw new Error("PIXIE_ALLOW_RENDER_DEPLOY=1 is required to deploy the runtime");
    await this.getService(serviceId);
    const deploy = { id: `dep-${this.deploys.size + 1}`, status: "created" };
    this.deploys.set(serviceId, deploy);
    return deploy;
  }

  async deployStatus(serviceId: string) {
    this.calls.push(`deployStatus:${serviceId}`);
    return this.deploys.get(serviceId) ?? null;
  }
}

export interface DeployOutput {
  log(text: string): void;
  error(text: string): void;
}

export async function runDeployCommand(
  command: string | undefined,
  provider: DeployProvider,
  env: Record<string, string | undefined>,
  out: DeployOutput
): Promise<number> {
  const serviceId = env.PIXIE_RENDER_SERVICE_ID;
  try {
    if (command === "services") {
      for (const service of await provider.listServices()) out.log(service.name);
      return 0;
    }
    if (command === "status") {
      if (!serviceId) throw new Error("PIXIE_RENDER_SERVICE_ID is required");
      const status = await provider.deployStatus(serviceId);
      if (status) out.log(`${status.id} ${status.status}`);
      return status ? 0 : 1;
    }
    if (command === "runtime") {
      if (!serviceId || env.PIXIE_RENDER_SERVICE_ID !== serviceId) throw new Error("PIXIE_RENDER_SERVICE_ID must identify the runtime service");
      if (env.PIXIE_ALLOW_RENDER_DEPLOY !== "1") throw new Error("PIXIE_ALLOW_RENDER_DEPLOY=1 is required to deploy the runtime");
      const deploy = await provider.triggerDeploy(serviceId);
      out.log(`${deploy.id} ${deploy.status}`);
      return 0;
    }
    throw new Error("usage: pixie deploy <services|status|runtime>");
  } catch (error) {
    out.error(error instanceof Error ? error.message : "Render command failed");
    return 1;
  }
}
