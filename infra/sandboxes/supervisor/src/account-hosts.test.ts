import { readFileSync } from "node:fs";
import { Duplex } from "node:stream";
import type Docker from "dockerode";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  accountHostCreateOptions,
  accountHostImageQualified,
  accountHostName,
  createAccountHostRoutes,
} from "./account-hosts.js";

const owner = {
  userId: "fixture-user",
  spaceId: "fixture-space",
  operationId: "fixture-login",
  leaseId: "11111111-1111-4111-8111-111111111111",
};
const expiresAt = new Date(Date.now() + 60_000).toISOString();
const input = () => ({
  ...owner,
  operation: "model-login" as const,
  expiresAt,
});
const headers = {
  authorization: "Bearer fixture-supervisor-token",
  "x-rakazo-expires-at": expiresAt,
  "x-rakazo-user-id": owner.userId,
  "x-rakazo-space-id": owner.spaceId,
  "x-rakazo-operation-id": owner.operationId,
  "x-rakazo-lease-id": owner.leaseId,
};
const qualifiedImage = (): { Id: string; Config: { Labels: Record<string, string> } } => ({
  Id: "sha256:fixture-pinned",
  Config: {
    Labels: {
      "rakazo.account-host.protocol": "1",
      "rakazo.account-host.qualified": "true",
    },
  },
});
function missing() {
  return Object.assign(new Error("missing"), { statusCode: 404 });
}
function fixture() {
  const containers = new Map<string, ReturnType<typeof container>>();
  const networks = new Map<
    string,
    { Id: string; Labels: Record<string, string>; remove: ReturnType<typeof vi.fn> }
  >();
  function container(options: Docker.ContainerCreateOptions) {
    const info = {
      Id: options.name!,
      Image: options.Image,
      Config: { Labels: options.Labels },
      State: { Status: "created", Running: false, ExitCode: 0 },
    };
    let stream: Duplex;
    return {
      info,
      options,
      inspect: vi.fn(async () => info),
      remove: vi.fn(async () => {
        containers.delete(options.name!);
      }),
      start: vi.fn(async () => {
        info.State.Status = "running";
        info.State.Running = true;
      }),
      attach: vi.fn(async () => {
        stream = new Duplex({
          read() {},
          write(_data, _encoding, callback) {
            callback();
          },
          final(callback) {
            info.State.Status = "exited";
            info.State.Running = false;
            stream.push(null);
            callback();
          },
        });
        return stream;
      }),
    };
  }
  const docker = {
    getImage: vi.fn(() => ({ inspect: vi.fn(async () => qualifiedImage()) })),
    createContainer: vi.fn(async (options: Docker.ContainerCreateOptions) => {
      if (containers.has(options.name!))
        throw Object.assign(new Error("name conflict"), { statusCode: 409 });
      const value = container(options);
      containers.set(options.name!, value);
      return value;
    }),
    getContainer: vi.fn(
      (id: string) =>
        containers.get(id) ?? {
          inspect: async () => {
            throw missing();
          },
          remove: async () => {
            throw missing();
          },
        },
    ),
    createNetwork: vi.fn(async (options: { Name: string; Labels: Record<string, string> }) => {
      const network = {
        Id: options.Name,
        Labels: options.Labels,
        remove: vi.fn(async () => {
          networks.delete(options.Name);
        }),
      };
      networks.set(options.Name, network);
      return network;
    }),
    getNetwork: vi.fn((id: string) => {
      const network = networks.get(id);
      return network
        ? { ...network, inspect: async () => network }
        : {
            inspect: async () => {
              throw missing();
            },
            remove: async () => {
              throw missing();
            },
          };
    }),
    listContainers: vi.fn(async () =>
      [...containers.entries()].map(([Id, c]) => ({ Id, Labels: c.info.Config.Labels })),
    ),
    listNetworks: vi.fn(async () =>
      [...networks.entries()].map(([Id, n]) => ({ Id, Labels: n.Labels })),
    ),
  };
  const count = vi.fn(async () => 0);
  const deps = {
    docker: docker as unknown as Docker,
    image: "fixture:tag",
    token: "fixture-supervisor-token",
    withSpaceLock: async <T>(_key: string, fn: () => Promise<T>) => fn(),
    countSpaceContainers: count,
    spaceLimit: () => 0,
    prepareNetwork: vi.fn(async () => {}),
  };
  const host = createAccountHostRoutes(deps);
  const allocate = (value: object = input(), h = headers) =>
    host.app.request("/", {
      method: "POST",
      headers: { ...h, "content-type": "application/json" },
      body: JSON.stringify(value),
    });
  const open = (h = headers, start: object = { type: "start", argv: [] }) =>
    host.app.request(`/${accountHostName(owner.leaseId)}/process`, {
      method: "POST",
      headers: h,
      body: `${JSON.stringify(start)}\n{"type":"end"}\n`,
    });
  const destroy = (h = headers) =>
    host.app.request(`/${accountHostName(owner.leaseId)}`, { method: "DELETE", headers: h });
  return { ...host, docker, containers, networks, deps, allocate, open, destroy, count };
}

describe("private account execution hosts", () => {
  it("attests the actual owner-verified container image, not the current configured tag", async () => {
    const f = fixture();
    await f.allocate();
    const actual = `sha256:${"a".repeat(64)}`;
    f.containers.get(accountHostName(owner.leaseId))!.info.Image = actual;
    f.deps.image = "different:mutable-tag";
    const response = await f.open();
    expect(response.status).toBe(200);
    expect(response.headers.get("x-rakazo-account-image-id")).toBe(actual);
    await response.text();
  });
  it("requires explicitly qualified helper image with no implicit volumes", async () => {
    expect(accountHostImageQualified(qualifiedImage())).toBe(true);
    expect(accountHostImageQualified({ Config: { Labels: {} } })).toBe(false);
    expect(
      accountHostImageQualified({
        ...qualifiedImage(),
        Config: { ...qualifiedImage().Config, Volumes: { "/home/rakazo": {} } },
      }),
    ).toBe(false);
    const f = fixture();
    f.docker.getImage.mockImplementation(() => ({
      inspect: vi.fn(async () => ({ Id: "no", Config: { Labels: {} } })),
    }));
    expect((await f.allocate()).status).toBe(409);
    expect(f.docker.createContainer).not.toHaveBeenCalled();
    expect(await (await f.app.request("/capabilities", { headers })).json()).toEqual({
      supported: false,
      operations: [],
    });
  });

  it("allocates pinned image without home binds, volumes, ports, screen service or start", async () => {
    const f = fixture();
    expect((await f.allocate()).status).toBe(200);
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    expect(c.options.Image).toBe("sha256:fixture-pinned");
    expect(c.options.HostConfig).toMatchObject({
      Init: true,
      ReadonlyRootfs: true,
      CapDrop: ["ALL"],
      SecurityOpt: ["no-new-privileges:true"],
      NetworkMode: `${accountHostName(owner.leaseId)}-network`,
      LogConfig: { Type: "none" },
    });
    expect(c.options.User).toBe("1000:1000");
    expect(c.options.HostConfig).not.toHaveProperty("Binds");
    expect(c.options.HostConfig).not.toHaveProperty("Mounts");
    expect(c.options.HostConfig).not.toHaveProperty("PortBindings");
    expect(c.options.Labels).not.toHaveProperty("rakazo.botId");
    expect(c.start).not.toHaveBeenCalled();
  });

  it.each(["user", "space", "operation", "lease"])(
    "enforces %s ownership on every operation",
    async (key) => {
      const f = fixture();
      await f.allocate();
      const h = {
        ...headers,
        [`x-rakazo-${key}-id`]: key === "lease" ? "22222222-2222-4222-8222-222222222222" : "other",
      };
      expect((await f.allocate(input(), h)).status).toBe(400);
      expect((await f.open(h)).status).toBe(400);
      expect((await f.destroy(h)).status).toBe(400);
      expect(f.containers.size).toBe(1);
    },
  );

  it("rejects missing authorization, expired/extended leases, and arbitrary commands", async () => {
    const f = fixture();
    expect((await f.app.request("/capabilities")).status).toBe(401);
    for (const expiry of [Date.now() - 1, Date.now() + 16 * 60_000])
      expect(
        (await f.allocate({ ...input(), expiresAt: new Date(expiry).toISOString() })).status,
      ).toBe(400);
    await f.allocate();
    expect((await f.open(headers, { type: "start", argv: ["sh"] })).status).toBe(400);
    expect(
      (await f.open(headers, { type: "start", argv: [], env: { HOME: "/unsafe" } })).status,
    ).toBe(400);
    expect(f.containers.get(accountHostName(owner.leaseId))!.attach).not.toHaveBeenCalled();
  });

  it("counts account hosts against the shared space cap before creating resources", async () => {
    const f = fixture();
    f.deps.spaceLimit = () => 1;
    f.count.mockResolvedValue(1);
    expect((await f.allocate()).status).toBe(429);
    expect(f.docker.createNetwork).not.toHaveBeenCalled();
  });

  it("runs once with a durable stopped claim and rejects replay after a supervisor restart", async () => {
    const f = fixture();
    await f.allocate();
    const response = await f.open();
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"type":"exit"');
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    expect(c.start).toHaveBeenCalledOnce();
    const claim = f.containers.get(`${accountHostName(owner.leaseId)}-launch`)!;
    expect(claim.start).not.toHaveBeenCalled();
    expect(claim.options.HostConfig?.NetworkMode).toBe("none");
    const restarted = createAccountHostRoutes(f.deps);
    const replay = await restarted.app.request(`/${accountHostName(owner.leaseId)}/process`, {
      method: "POST",
      headers,
      body: '{"type":"start","argv":[]}\n',
    });
    expect(replay.status).toBe(400);
    expect(c.start).toHaveBeenCalledOnce();
    // Even stale created-state observation cannot steal a launch from another supervisor.
    c.info.State.Status = "created";
    expect((await f.open()).status).toBe(400);
    expect(c.start).toHaveBeenCalledOnce();
  });

  it("destroys host, launch claim and network; repeated destroy is idempotent", async () => {
    const f = fixture();
    await f.allocate();
    await (await f.open()).text();
    expect((await f.destroy()).status).toBe(200);
    expect([...f.containers.keys()]).toEqual([`${accountHostName(owner.leaseId)}-closed`]);
    expect(f.networks.size).toBe(0);
    expect((await f.destroy()).status).toBe(200);
  });

  it("reclaims expired/crashed allocations and networks without touching live leases", async () => {
    const f = fixture();
    await f.allocate();
    await f.sweep();
    expect(f.containers.size).toBe(1);
    for (const c of f.containers.values())
      c.info.Config.Labels!["rakazo.expiresAt"] = new Date(0).toISOString();
    for (const n of f.networks.values()) n.Labels["rakazo.expiresAt"] = new Date(0).toISOString();
    await f.sweep();
    expect(f.containers.size).toBe(0);
    expect(f.networks.size).toBe(0);
  });

  it("fails closed when host egress isolation cannot be established", async () => {
    const f = fixture();
    f.deps.prepareNetwork.mockRejectedValue(new Error("fixture network policy failure"));
    expect((await f.allocate()).status).toBe(400);
    expect(f.docker.createNetwork).not.toHaveBeenCalled();
    expect(f.docker.createContainer).not.toHaveBeenCalled();
  });

  it("rejects corrupt expiry labels before attach and never forwards credentials", async () => {
    const f = fixture();
    await f.allocate();
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    c.info.Config.Labels!["rakazo.expiresAt"] = "not-a-date";
    expect((await f.open()).status).toBe(400);
    expect(c.attach).not.toHaveBeenCalled();
  });

  it("preserves a launch fence when starting fails; later callers cannot retry", async () => {
    const f = fixture();
    await f.allocate();
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    c.start.mockRejectedValue(new Error("synthetic lost start response"));
    expect((await f.open()).status).toBe(400);
    expect((await f.open()).status).toBe(400);
    expect(c.start).toHaveBeenCalledOnce();
    expect(f.containers.has(`${accountHostName(owner.leaseId)}-launch`)).toBe(true);
  });

  it("does not report successful destruction when container deletion is unconfirmed", async () => {
    const f = fixture();
    await f.allocate();
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    c.remove.mockRejectedValue(new Error("synthetic transport failure"));
    expect((await f.destroy()).status).toBe(400);
    expect(f.containers.size).toBe(2);
  });

  it("attempts other expired resources even if one cleanup fails", async () => {
    const f = fixture();
    await f.allocate();
    await (await f.open()).text();
    for (const c of f.containers.values())
      c.info.Config.Labels!["rakazo.expiresAt"] = new Date(0).toISOString();
    for (const n of f.networks.values()) n.Labels["rakazo.expiresAt"] = new Date(0).toISOString();
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    c.remove.mockRejectedValue(new Error("synthetic cleanup failure"));
    await expect(f.sweep()).rejects.toThrow("cleanup incomplete");
    expect(f.containers.size).toBe(1);
    expect(f.containers.has(`${accountHostName(owner.leaseId)}-launch`)).toBe(false);
    expect(f.networks.size).toBe(0);
  });

  it("mounts the allocation route at the shared non-trailing-slash endpoint", async () => {
    const f = fixture();
    const app = new Hono();
    app.route("/account-hosts", f.app);
    const response = await app.request("/account-hosts", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(input()),
    });
    expect(response.status).toBe(200);
  });

  it("packages the helper launcher with quoted operation argument forwarding", () => {
    const launcher = readFileSync(
      new URL("../../computer/acp-host-launcher", import.meta.url),
      "utf8",
    );
    expect(launcher.trim()).toBe(
      '#!/bin/sh\n# Private account helper: native-created conversation files must remain owner-only.\numask 077\nexec /usr/local/bin/node /usr/local/lib/rakazo-acp-host.mjs "$@"',
    );
  });

  it("fences a delayed allocation when another supervisor confirms DELETE first", async () => {
    const f = fixture();
    const create = f.docker.createContainer.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.docker.createContainer.mockImplementation(async (options) => {
      if (options.name === accountHostName(owner.leaseId)) {
        entered();
        await blocked;
      }
      return create(options);
    });
    const pending = f.allocate();
    await creating;
    const other = createAccountHostRoutes(f.deps);
    expect(
      (await other.app.request(`/${accountHostName(owner.leaseId)}`, { method: "DELETE", headers }))
        .status,
    ).toBe(200);
    release();
    expect((await pending).status).toBe(400);
    expect([...f.containers.keys()]).toEqual([`${accountHostName(owner.leaseId)}-closed`]);
    expect((await f.allocate()).status).toBe(400);
    expect((await f.open()).status).toBe(400);
  });

  it("rejects a process whose launch claim completes after another supervisor closes the lease", async () => {
    const f = fixture();
    await f.allocate();
    const c = f.containers.get(accountHostName(owner.leaseId))!;
    const create = f.docker.createContainer.getMockImplementation()!;
    let release!: () => void;
    let entered!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const creating = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.docker.createContainer.mockImplementation(async (options) => {
      if (options.name === `${accountHostName(owner.leaseId)}-launch`) {
        entered();
        await blocked;
      }
      return create(options);
    });
    const pending = f.open();
    await creating;
    const other = createAccountHostRoutes(f.deps);
    expect(
      (await other.app.request(`/${accountHostName(owner.leaseId)}`, { method: "DELETE", headers }))
        .status,
    ).toBe(200);
    release();
    expect((await pending).status).toBe(400);
    expect(c.start).not.toHaveBeenCalled();
    expect(c.attach).not.toHaveBeenCalled();
    expect([...f.containers.keys()]).toEqual([`${accountHostName(owner.leaseId)}-closed`]);
  });

  it("requires matching expiry on delete and rejects extended absent-host tombstones", async () => {
    const f = fixture();
    await f.allocate();
    expect(
      (
        await f.destroy({
          ...headers,
          "x-rakazo-expires-at": new Date(Date.parse(expiresAt) + 1000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(f.containers.size).toBe(1);
    const empty = fixture();
    expect(
      (
        await empty.destroy({
          ...headers,
          "x-rakazo-expires-at": new Date(Date.now() + 16 * 60_000).toISOString(),
        })
      ).status,
    ).toBe(400);
    expect(empty.containers.size).toBe(0);
    expect((await empty.destroy()).status).toBe(200);
    expect((await empty.allocate()).status).toBe(400);
  });

  it("supports the same isolated host boundary for inference", async () => {
    const f = fixture();
    expect((await f.allocate({ ...input(), operation: "model" })).status).toBe(200);
    expect(f.containers.get(accountHostName(owner.leaseId))!.options.Cmd?.[0]).toContain(
      "--operation model",
    );
  });

  it("bounds PID1 lifetime to absolute expiry even after delayed start", () => {
    const options = accountHostCreateOptions(input(), "fixture:image");
    expect(options.Cmd?.[0]).toContain("$(date +%s%3N)");
    expect(options.Cmd?.[0]).toContain("rakazo-process");
    expect(options.HostConfig?.RestartPolicy?.Name).toBe("no");
  });
});
