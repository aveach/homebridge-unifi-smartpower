import { API } from 'homebridge';
import { PLATFORM_NAME } from './settings';
import { UniFiSmartPowerHomebridgePlatform } from './platform';
import { expect, jest } from '@jest/globals';
import index from './index';

jest.mock('homebridge');
jest.mock('./settings');
jest.mock('./platform');

describe('index.ts', () => {
  it('should register the platform with Homebridge', () => {
    const api = {
      registerPlatform: jest.fn(),
    } as unknown as API;
    index(api);

    expect(api.registerPlatform).toHaveBeenCalledWith(
      PLATFORM_NAME,
      UniFiSmartPowerHomebridgePlatform,
    );
  });
});
