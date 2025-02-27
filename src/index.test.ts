import { describe, it, expect, vi } from 'vitest';
import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { UniFiSmartPowerHomebridgePlatform } from './platform';
import registerPlatform from './index';

describe('index', () => {
  it('should register the platform with Homebridge', () => {
    const api = {
      registerPlatform: vi.fn(),
    } as unknown as API;

    registerPlatform(api);

    expect(api.registerPlatform).toHaveBeenCalledWith(
      PLATFORM_NAME,
      UniFiSmartPowerHomebridgePlatform,
    );
  });
});
