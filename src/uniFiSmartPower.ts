import PubSub from 'pubsub-js';
import { Logger } from 'homebridge';

import { Cache, createCache } from 'cache-manager';
import AsyncLock from 'async-lock';
type Token = string;
import { Controller } from 'node-unifi';
import { Keyv, KeyvCacheableMemory } from 'cacheable';

export interface UniFiDeviceStatus {
  device: UniFiDevice;
  ports: UniFiSwitchPort[];
  outlets: UniFiSmartPowerOutlet[];
  rpsPorts: UniFiRpsPort[];
}

export interface UniFiDevice {
  site: string;
  id: string;
  ip: string;
  mac: string;
  model: string;
  version: string;
  serialNumber: string;
  name: string;
}

export interface UniFiSmartPowerOutlet {
  index: number;
  name: string;
  relayState: UniFiSmartPowerOutletState;
  inUse: UniFiPortOrOutletInUse;
  entry: UniFiApiDeviceOutletTable;
  override: UniFiApiDeviceOutletOverride;
}

export interface UniFiSwitchPort {
  index: number;
  name: string;
  poeMode: UniFiSwitchPortPoeMode;
  poeOnAction: UniFiSwitchPortPoeModeAction;
  inUse: UniFiPortOrOutletInUse;
  active: boolean;
  entry: UniFiApiDeviceSwitchPortTable;
  override: UniFiApiDeviceSwitchPortOverride;
}

export interface UniFiRpsPort {
  index: number;
  name: string;
  portMode: UniFiRpsPortMode;
  inUse: UniFiPortOrOutletInUse;
  active: boolean;
  entry: UniFiApiDeviceRpsPortTable;
  override: UniFiApiDeviceRpsPortTableOverride;
}

export type UniFiSwitchPortPoeMode = 'unknown' | 'auto' | 'passthrough' | 'pasv24' | 'off';
export type UniFiSwitchPortPoeModeAction = 'auto' | 'passthrough' | 'pasv24' | 'off';
export type UniFiRpsPortMode = 'auto' | 'disabled';

export enum UniFiSmartPowerOutletState {
  UNKNOWN = -1,
  OFF = 0,
  ON = 1,
}

export enum UniFiPortOrOutletInUse {
  UNKNOWN = -1,
  NO = 0,
  YES = 1,
}

export enum UniFiSmartPowerOutletAction {
  OFF = 0,
  ON = 1,
}

export enum UniFiRpsPortAction {
  OFF = 0,
  ON = 1,
}

export enum UniFiDeviceKind {
  OUTLET = 0,
  PORT = 1,
  RPS_PORT = 2,
}

export const UniFiSwitchPortPoeCaps = {
  '8023AF': 1,
  '8023AT': 2,
  PASV24: 4,
  PASSTHROUGHABLE: 8,
  PASSTHROUGH: 16,
  '8023BT': 32,
};

export interface UniFiControllerConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  refreshDevicesPollInterval?: number;
  outletStatusPollInterval?: number;
  outletStatusCacheTtl?: number;
}

export interface UniFiSite {
  id: string;
  name: string;
}

export class UniFiSmartPower {
  private static readonly PUB_SUB_OUTLET_TOPIC = 'outlet';

  private static readonly STATUS_CACHE_KEY = 'outlet-status';
  private static readonly STATUS_CACHE_TTL_MS_DEFAULT = 15 * 1000;
  private static readonly STATUS_CACHE_TTL_MS_MIN = 5 * 1000;
  private static readonly STATUS_CACHE_TTL_MS_MAX = 60 * 1000;

  private static readonly STATUS_POLL_INTERVAL_MS_DEFAULT = 15 * 1000;
  private static readonly STATUS_POLL_INTERVAL_MS_MIN = 5 * 1000;
  private static readonly STATUS_POLL_INTERVAL_MS_MAX = 60 * 1000;

  private static readonly CONTROLLER_LOCK = 'CONTROLLER_LOCK';
  private static readonly STALE_COMMAND_GUARD_MS = 5 * 1000;

  private readonly lock = new AsyncLock({ domainReentrant: true });
  private readonly cache: Cache;
  private readonly controller: Controller;
  private loggedIn = false;
  private readonly deviceSnapshots = new Map<string, UniFiDeviceStatus>();
  private readonly devicePollers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly deviceSubscriberCount = new Map<string, number>();
  private readonly pendingCommands = new Map<string, number>();

  constructor(
    public readonly log: Logger,
    private readonly config: UniFiControllerConfig,
  ) {
    const store = new KeyvCacheableMemory({
      ttl: undefined, // No default ttl
      lruSize: 0, // Infinite capacity
    });
    const keyv = new Keyv({ store });
    this.cache = createCache({ stores: [keyv] });
    this.controller = new Controller({
      host: this.config.host,
      port: this.config.port,
      username: this.config.username,
      password: this.config.password,
      sslverify: false,
    });
  }

  reset(): void {
    PubSub.clearAllSubscriptions();
    for (const timer of this.devicePollers.values()) {
      clearTimeout(timer);
    }
    this.devicePollers.clear();
    this.deviceSubscriberCount.clear();
    this.pendingCommands.clear();
  }

  subscribe(
    device: UniFiDevice,
    kind: UniFiDeviceKind,
    index: number,
    func:
      | ((outlet: UniFiSmartPowerOutlet) => void)
      | ((port: UniFiSwitchPort) => void)
      | ((rpsPort: UniFiRpsPort) => void),
  ): Token {
    const topic = UniFiSmartPower.statusTopic(device, kind, index);
    const token = PubSub.subscribe(topic, async (_, data) => {
      if (!data) {
        return;
      }
      func(data);
    });
    this.log.debug(
      '[API] Status subscription added for%s %s.%s [token=%s]',
      {
        [UniFiDeviceKind.OUTLET]: ' outlet',
        [UniFiDeviceKind.PORT]: ' port',
        [UniFiDeviceKind.RPS_PORT]: ' RPS port',
      }[kind] ?? '',
      device.mac,
      index,
      token,
    );

    const subscribers = (this.deviceSubscriberCount.get(device.id) ?? 0) + 1;
    this.deviceSubscriberCount.set(device.id, subscribers);
    if (subscribers === 1) {
      this.startDevicePoller(device);
    }
    return token;
  }

  unsubscribe(token: Token): void {
    PubSub.unsubscribe(token);
    this.log.debug('[API] Status subscription removed for token %s', token);
  }

  async getSites(): Promise<UniFiSite[]> {
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      this.log.debug('[API] Fetching sites from UniFi API');
      const sites = (await this.withSession(() => this.controller.getSitesStats())) as Array<{
        name?: string;
        desc?: string;
      }>;
      return sites
        .filter(({ name }) => !!name)
        .map(({ name: id, desc: name }) => ({
          id: id as string,
          name: name as string,
        }));
    });
  }

  async getDeviceStatuses(site: string, acquireLock?: boolean): Promise<UniFiDeviceStatus[]>;
  async getDeviceStatuses(device: UniFiDevice, acquireLock?: boolean): Promise<UniFiDeviceStatus[]>;

  async getDeviceStatuses(
    siteOrDevice: string | UniFiDevice,
    acquireLock = true,
  ): Promise<UniFiDeviceStatus[]> {
    let site: string;
    let device: UniFiDevice | null;
    let errMsg = '';
    if (typeof siteOrDevice === 'string') {
      site = siteOrDevice;
      errMsg = `site ${site} `;
      device = null;
    } else if (siteOrDevice) {
      device = siteOrDevice;
      site = device.site;
      errMsg = `device ${device.name} [${device.mac}] `;
    }
    const fetch = async (): Promise<UniFiDeviceStatus[]> => {
      const result: UniFiDeviceStatus[] | Error = await this.cache.wrap(
        UniFiSmartPower.deviceCacheKey(device),
        async (): Promise<UniFiDeviceStatus[] | Error> => {
          this.log.debug('[API] Fetching status from UniFi API');
          this.controller.opts.site = site;
          let result: UniFiApiDevice[] = [],
            error: Error | null = null;
          try {
            result = await this.withSession(() =>
              this.controller.getAccessDevices(device?.mac ?? ''),
            );
          } catch (e: unknown) {
            error = e as Error;
            this.log.error(
              '[API] An error occurred polling %sfor a status update; %s',
              errMsg,
              error.message,
            );
          }
          return (
            error ??
            result
              .filter(
                (device: UniFiApiDevice) =>
                  (device.outlet_table ?? []).length > 0 ||
                  (device.port_table ?? []).length > 0 ||
                  (device?.rps?.rps_port_table ?? []).length > 0,
              )
              .map((device: UniFiApiDevice) =>
                UniFiSmartPower.transformDeviceStatusResponse(site, device),
              )
          );
        },
        this.statusCacheTtlMs,
      );
      if (result instanceof Error) {
        throw result;
      }
      for (const status of result) {
        this.deviceSnapshots.set(status.device.id, status);
      }
      return result;
    };
    return acquireLock ? this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, fetch) : fetch();
  }

  private static transformDeviceStatusResponse(
    site: string,
    {
      _id: id,
      ip,
      mac,
      model,
      version,
      serial: serialNumber,
      name,
      port_table: ports,
      port_overrides: portOverrides,
      outlet_table: outlets,
      outlet_overrides: outletOverrides,
      rps: rps,
      rps_override: rpsPortOverride,
    }: UniFiApiDevice,
  ): UniFiDeviceStatus {
    return {
      device: {
        site,
        id,
        ip,
        mac,
        model,
        version,
        serialNumber,
        name: name || model || serialNumber,
      },
      ports: (
        ports
          ?.filter(({ port_poe: isPoePort }) => !!isPoePort)
          .map(
            (entry: UniFiApiDeviceSwitchPortTable): UniFiSwitchPort => ({
              index: entry.port_idx,
              name: entry.name ?? `Port ${entry.port_idx}`,
              poeMode: entry.poe_mode || 'off',
              inUse: !entry.poe_power ? -1 : parseFloat(entry.poe_power) > 0 ? 1 : 0,
              active: !!entry.poe_enable,
              poeOnAction: this.getPortPoeOnMode(entry.poe_caps),
              entry,
              override:
                portOverrides?.find((p) => p?.port_idx === entry.port_idx) ??
                (Object.fromEntries(
                  Object.entries(entry).filter(([k]) =>
                    ['port_idx', 'name', 'poe_mode', 'portconf_id'].includes(k),
                  ),
                ) as UniFiApiDeviceSwitchPortOverride),
            }),
          ) ?? []
      ).filter((p) => p.poeOnAction !== 'off' && p.override && p.entry),
      outlets: (
        outlets?.map(
          (entry: UniFiApiDeviceOutletTable): UniFiSmartPowerOutlet => ({
            index: entry.index,
            name: entry.name ?? `Outlet ${entry.index}`,
            relayState: entry.relay_state ? 1 : 0,
            inUse: !entry.outlet_power ? -1 : parseFloat(entry.outlet_power) > 0 ? 1 : 0,
            entry,
            override:
              outletOverrides?.find((o) => o?.index === entry.index) ??
              (Object.fromEntries(
                Object.entries(entry).filter(([k]) => ['index', 'name', 'relay_state'].includes(k)),
              ) as UniFiApiDeviceOutletOverride),
          }),
        ) ?? []
      ).filter((o) => o.override && o.entry),
      rpsPorts: (
        rps?.rps_port_table.map(
          (entry: UniFiApiDeviceRpsPortTable): UniFiRpsPort => ({
            index: entry.port_idx,
            name: entry.name ?? `RPS Port ${entry.port_idx}`,
            portMode: entry.port_mode || 'disabled',
            inUse: entry.power_delivering ? 1 : 0,
            active: !!entry.power_active,
            entry,
            override:
              rpsPortOverride?.rps_port_table?.find((p) => p?.port_idx === entry.port_idx) ??
              (Object.fromEntries(
                Object.entries(entry).filter(([k]) =>
                  ['port_idx', 'name', 'port_mode'].includes(k),
                ),
              ) as UniFiApiDeviceRpsPortTableOverride),
          }),
        ) ?? []
      ).filter((p) => p.override && p.entry),
    };
  }

  private static getPortPoeOnMode(
    poeCaps: number | null | undefined,
  ): UniFiSwitchPortPoeModeAction {
    if (
      // We already filter out non-poe ports and if it doesn't have cps then it supports auto
      poeCaps === undefined ||
      poeCaps === null ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8023AF']) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8023AT']) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps['8028023BT3AF'])
    ) {
      return 'auto';
    }
    if (
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASSTHROUGH) ||
      this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASSTHROUGHABLE)
    ) {
      return 'passthrough';
    }
    if (this.poeSupportsMode(poeCaps, UniFiSwitchPortPoeCaps.PASV24)) {
      return 'pasv24';
    }
    return 'off';
  }

  private static poeSupportsMode(poeCaps: number | null | undefined, cap: number): boolean {
    return !!poeCaps && (poeCaps & cap) === cap;
  }

  async getDeviceStatus(device: UniFiDevice, acquireLock = true): Promise<UniFiDeviceStatus> {
    const devices = await this.getDeviceStatuses(device, acquireLock);
    if (devices.length !== 1) {
      throw new Error(`unknown device with id=${device.id}`);
    }
    return devices[0];
  }

  async getPortStatus(device: UniFiDevice, portIndex: number): Promise<UniFiSwitchPort> {
    const { ports } = await this.getDeviceStatus(device);
    const portInfo = ports.find(({ index }) => index === portIndex) ?? null;
    if (portInfo === null) {
      throw new Error(`unknown port with id=${portIndex}`);
    }
    return portInfo;
  }

  async getOutletStatus(device: UniFiDevice, outletIndex: number): Promise<UniFiSmartPowerOutlet> {
    const { outlets } = await this.getDeviceStatus(device);
    const outletInfo = outlets.find(({ index }) => index === outletIndex) ?? null;
    if (outletInfo === null) {
      throw new Error(`unknown outlet with id=${outletIndex}`);
    }
    return outletInfo;
  }

  async getRpsPortStatus(device: UniFiDevice, portIndex: number): Promise<UniFiRpsPort> {
    const { rpsPorts } = await this.getDeviceStatus(device);
    const portInfo = rpsPorts.find(({ index }) => index === portIndex) ?? null;
    if (portInfo === null) {
      throw new Error(`unknown rps port with id=${portIndex}`);
    }
    return portInfo;
  }

  async commandOutlet(
    device: UniFiDevice,
    outletIndex: number,
    command: UniFiSmartPowerOutletAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      const status = await this.getCachedOrFreshDeviceStatus(device);
      this.controller.opts.site = device.site;
      await this.withSession(() =>
        this.controller.setDeviceSettingsBase(device.id, {
          outlet_overrides: status.outlets.map((outlet) => ({
            ...outlet.override,
            relay_state: outlet.index === outletIndex ? !!command : !!outlet.relayState,
          })),
        }),
      );
      const outlet = status.outlets.find(({ index }) => index === outletIndex);
      if (outlet) {
        outlet.relayState = command === UniFiSmartPowerOutletAction.ON
          ? UniFiSmartPowerOutletState.ON
          : UniFiSmartPowerOutletState.OFF;
        outlet.override = { ...outlet.override, relay_state: !!command };
      }
      this.deviceSnapshots.set(device.id, status);
      await this.invalidateStatusCache(device);
      this.publishDeviceStatus(status);
      this.markPending(device, UniFiDeviceKind.OUTLET, outletIndex);
    });
  }

  async commandPort(
    device: UniFiDevice,
    portIndex: number,
    poeMode: UniFiSwitchPortPoeModeAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      const status = await this.getCachedOrFreshDeviceStatus(device);
      this.controller.opts.site = device.site;
      await this.withSession(() =>
        this.controller.setDeviceSettingsBase(device.id, {
          port_overrides: status.ports.map((port) => ({
            ...port.override,
            poe_mode: port.index === portIndex ? poeMode : port.poeMode,
          })),
        }),
      );
      const port = status.ports.find(({ index }) => index === portIndex);
      if (port) {
        port.poeMode = poeMode;
        port.override = { ...port.override, poe_mode: poeMode };
      }
      this.deviceSnapshots.set(device.id, status);
      await this.invalidateStatusCache(device);
      this.publishDeviceStatus(status);
      this.markPending(device, UniFiDeviceKind.PORT, portIndex);
    });
  }

  async commandRpsPort(
    device: UniFiDevice,
    portIndex: number,
    command: UniFiRpsPortAction,
  ): Promise<void> {
    return this.lock.acquire(UniFiSmartPower.CONTROLLER_LOCK, async () => {
      const status = await this.getCachedOrFreshDeviceStatus(device);
      const portMode = command === UniFiRpsPortAction.ON ? 'auto' : 'disabled';
      this.controller.opts.site = device.site;
      await this.withSession(() =>
        this.controller.setDeviceSettingsBase(device.id, {
          rps_override: {
            rps_port_table: status.rpsPorts.map((port) => ({
              ...port.override,
              port_mode: port.index === portIndex ? portMode : port.portMode,
            })),
          },
        }),
      );
      const port = status.rpsPorts.find(({ index }) => index === portIndex);
      if (port) {
        port.portMode = portMode;
        port.override = { ...port.override, port_mode: portMode };
      }
      this.deviceSnapshots.set(device.id, status);
      await this.invalidateStatusCache(device);
      this.publishDeviceStatus(status);
      this.markPending(device, UniFiDeviceKind.RPS_PORT, portIndex);
    });
  }

  private async getCachedOrFreshDeviceStatus(device: UniFiDevice): Promise<UniFiDeviceStatus> {
    const snapshot = this.deviceSnapshots.get(device.id);
    if (snapshot) {
      return snapshot;
    }
    return this.getDeviceStatus(device, false);
  }

  private async invalidateStatusCache(device: UniFiDevice): Promise<void> {
    await this.cache.del(UniFiSmartPower.deviceCacheKey(device));
    await this.cache.del(UniFiSmartPower.deviceCacheKey());
  }

  private startDevicePoller(device: UniFiDevice): void {
    const poll = async () => {
      if ((this.deviceSubscriberCount.get(device.id) ?? 0) === 0) {
        this.devicePollers.delete(device.id);
        return;
      }
      try {
        this.log.debug('[API] Polling status for device %s [%s]', device.name, device.mac);
        const status = await this.getDeviceStatus(device);
        this.publishDeviceStatus(status);
      } catch {
        // Already logged in getDeviceStatuses.
      }
      if ((this.deviceSubscriberCount.get(device.id) ?? 0) === 0) {
        this.devicePollers.delete(device.id);
        return;
      }
      this.devicePollers.set(
        device.id,
        setTimeout(poll, this.statusPollIntervalMs),
      );
    };
    this.devicePollers.set(device.id, setTimeout(poll, 0));
  }

  private publishDeviceStatus(status: UniFiDeviceStatus): void {
    for (const outlet of status.outlets) {
      if (!this.isPending(status.device, UniFiDeviceKind.OUTLET, outlet.index)) {
        PubSub.publish(
          UniFiSmartPower.statusTopic(status.device, UniFiDeviceKind.OUTLET, outlet.index),
          outlet,
        );
      }
    }
    for (const port of status.ports) {
      if (!this.isPending(status.device, UniFiDeviceKind.PORT, port.index)) {
        PubSub.publish(
          UniFiSmartPower.statusTopic(status.device, UniFiDeviceKind.PORT, port.index),
          port,
        );
      }
    }
    for (const rpsPort of status.rpsPorts) {
      if (!this.isPending(status.device, UniFiDeviceKind.RPS_PORT, rpsPort.index)) {
        PubSub.publish(
          UniFiSmartPower.statusTopic(status.device, UniFiDeviceKind.RPS_PORT, rpsPort.index),
          rpsPort,
        );
      }
    }
  }

  private markPending(device: UniFiDevice, kind: UniFiDeviceKind, index: number): void {
    this.pendingCommands.set(
      UniFiSmartPower.pendingKey(device, kind, index),
      Date.now() + UniFiSmartPower.STALE_COMMAND_GUARD_MS,
    );
  }

  private isPending(device: UniFiDevice, kind: UniFiDeviceKind, index: number): boolean {
    const key = UniFiSmartPower.pendingKey(device, kind, index);
    const expires = this.pendingCommands.get(key);
    if (expires === undefined) {
      return false;
    }
    if (Date.now() >= expires) {
      this.pendingCommands.delete(key);
      return false;
    }
    return true;
  }

  private async withSession<T>(fn: () => Promise<T>): Promise<T> {
    try {
      await this.ensureLoggedIn();
      return await fn();
    } catch (error: unknown) {
      if (!UniFiSmartPower.isAuthError(error)) {
        throw error;
      }
      this.log.debug('[API] Session expired; logging in again');
      this.loggedIn = false;
      await this.ensureLoggedIn();
      return fn();
    }
  }

  private async ensureLoggedIn(): Promise<void> {
    if (this.loggedIn) {
      return;
    }
    await this.controller.login();
    this.loggedIn = true;
  }

  private static isAuthError(error: unknown): boolean {
    const message = `${(<Error>error)?.message ?? error} ${JSON.stringify(error)}`.toLowerCase();
    return (
      message.includes('loginrequired') ||
      message.includes('unauthorized') ||
      message.includes('status code 401') ||
      message.includes('api.err.login')
    );
  }

  private static pendingKey(device: UniFiDevice, kind: UniFiDeviceKind, index: number): string {
    return `${device.id}.${kind}.${index}`;
  }

  private get statusCacheTtlMs(): number {
    return Math.max(
      UniFiSmartPower.STATUS_CACHE_TTL_MS_MIN,
      Math.min(
        UniFiSmartPower.STATUS_CACHE_TTL_MS_MAX,
        (this.config.outletStatusCacheTtl ?? 0) * 1000 ||
          UniFiSmartPower.STATUS_CACHE_TTL_MS_DEFAULT,
      ),
    );
  }

  private get statusPollIntervalMs(): number {
    return Math.max(
      UniFiSmartPower.STATUS_POLL_INTERVAL_MS_MIN,
      Math.min(
        UniFiSmartPower.STATUS_POLL_INTERVAL_MS_MAX,
        (this.config.outletStatusPollInterval ?? 0) * 1000 ||
          UniFiSmartPower.STATUS_POLL_INTERVAL_MS_DEFAULT,
      ),
    );
  }

  private static statusTopic(device: UniFiDevice, kind: UniFiDeviceKind, index: number): string {
    return `${UniFiSmartPower.PUB_SUB_OUTLET_TOPIC}.${device.id}.${kind}.${index}`;
  }

  private static deviceCacheKey(device: UniFiDevice | null = null): string {
    return `${UniFiSmartPower.STATUS_CACHE_KEY}.${device?.id ?? 'ALL'}`;
  }
}

type UniFiApiDevice = {
  _id: string;
  ip: string;
  mac: string;
  model: string;
  version: string;
  serial: string;
  name?: string;
  port_table: UniFiApiDeviceSwitchPortTable[] | null | undefined;
  port_overrides: UniFiApiDeviceSwitchPortOverride[] | null | undefined;
  outlet_table: UniFiApiDeviceOutletTable[] | null | undefined;
  outlet_overrides: UniFiApiDeviceOutletOverride[] | null | undefined;
  rps: UniFiApiDeviceRps | null | undefined;
  rps_override: UniFiApiDeviceRpsPortOverride | null | undefined;
};

type UniFiApiDeviceSwitchPortTable = {
  port_idx: number;
  name?: string;
  port_poe?: boolean;
  poe_mode?: UniFiSwitchPortPoeModeAction;
  poe_caps?: number;
  poe_power?: string;
  poe_enable?: boolean;
  // many others
};

type UniFiApiDeviceSwitchPortOverride = {
  port_idx: number;
  name?: string;
  poe_mode: UniFiSwitchPortPoeModeAction;
};

type UniFiApiDeviceRpsPortTable = {
  port_idx: number;
  name?: string;
  port_mode?: UniFiRpsPortMode;
  up?: boolean;
  power_active?: boolean;
  power_delivering?: boolean;
  // many others
};

type UniFiApiDeviceRpsPortTableOverride = {
  port_idx: number;
  name?: string;
  port_mode: UniFiRpsPortMode;
};

type UniFiApiDeviceRpsPortOverride = {
  rps_port_table: UniFiApiDeviceRpsPortTableOverride[];
};

type UniFiApiDeviceRps = {
  rps_port_table: UniFiApiDeviceRpsPortTable[];
};

type UniFiApiDeviceOutletTable = {
  index: number;
  name?: string;
  relay_state: boolean;
  outlet_power?: string;
  outlet_caps?: number;
};

type UniFiApiDeviceOutletOverride = {
  index: number;
  name?: string;
  relay_state: boolean;
};
