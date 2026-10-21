import { CatPrinterCommand } from '../protocol/command.ts';

/**
 * Web Bluetooth Printing Service for Cat / FunPrint / iPrint BLE thermal printers.
 * Ported from `Sources/CatPrinterEngine/BLEPrinterManager.swift` for Chrome's `navigator.bluetooth` API.
 */

export type PrinterConnectionState =
  | 'disconnected'
  | 'scanning'
  | 'connecting'
  | 'connected'
  | 'printing';

export type FeedMode = 'blankLines' | 'nativeCommand';

export interface PrinterSettings {
  targetDeviceName: string;
  feedMode: FeedMode;
  feedAmount: number;
  feedAfterPrint: boolean;
  retractBeforePrint: boolean;
  retractAmount: number;
  energyLevel: number;
  lineDelayMs: number;
}

export interface CatPrinterEvents {
  stateChange: (state: PrinterConnectionState, printerName: string | null) => void;
  progress: (progress: number) => void;
  log: (entry: string, allLogs: ReadonlyArray<string>) => void;
  notification: (bytes: Uint8Array) => void;
}

type EventKey = keyof CatPrinterEvents;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(' ');
}

export class CatPrinterService {
  // Known BLE Services for Cat & FunPrint
  public static readonly SERVICE_UUID_AE30 = '0000ae30-0000-1000-8000-00805f9b34fb';
  public static readonly SERVICE_UUID_AF30 = '0000af30-0000-1000-8000-00805f9b34fb';

  // Known BLE Characteristics
  public static readonly CHAR_UUID_AE01 = '0000ae01-0000-1000-8000-00805f9b34fb';
  public static readonly CHAR_UUID_AE02 = '0000ae02-0000-1000-8000-00805f9b34fb';

  // Advertised device name prefixes (case-sensitive in Web Bluetooth filters)
  public static readonly KNOWN_NAME_PREFIXES: ReadonlyArray<string> = [
    'MX',
    'mx',
    'FUN',
    'Fun',
    'PRINT',
    'Print',
    'CAT',
    'Cat',
    'GB',
    'GT',
    'YT',
    'BQ',
    'Q5',
    'iPrint',
    'IPRINT',
    'Walk',
    'WALK',
  ];

  public settings: PrinterSettings = {
    targetDeviceName: 'MX06',
    feedMode: 'blankLines',
    feedAmount: 80, // lines or steps
    feedAfterPrint: true,
    retractBeforePrint: false,
    retractAmount: 80, // steps (~10mm at 8 dots/mm)
    energyLevel: 0x7000, // medium-high darkness
    lineDelayMs: 15, // milliseconds between line writes
  };

  private _connectionState: PrinterConnectionState = 'disconnected';
  private _printProgress: number = 0;
  private _logMessages: string[] = [];
  private _device: BluetoothDevice | null = null;
  private _server: BluetoothRemoteGATTServer | null = null;
  private _writeCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private _notifyCharacteristic: BluetoothRemoteGATTCharacteristic | null = null;
  private _preferWriteWithoutResponse: boolean = true;
  private _isPrintingCancelled: boolean = false;

  private readonly _listeners: {
    [K in EventKey]: Set<CatPrinterEvents[K]>;
  } = {
    stateChange: new Set(),
    progress: new Set(),
    log: new Set(),
    notification: new Set(),
  };

  private readonly _boundOnDisconnected = () => {
    this.handleDisconnected();
  };

  private readonly _boundOnNotification = (event: Event) => {
    const target = event.target as BluetoothRemoteGATTCharacteristic | null;
    if (target?.value) {
      const bytes = new Uint8Array(
        target.value.buffer,
        target.value.byteOffset,
        target.value.byteLength
      );
      this.log(`Notification from ${target.uuid.slice(4, 8).toUpperCase()}: ${formatHex(bytes)}`);
      for (const listener of this._listeners.notification) {
        listener(bytes);
      }
    }
  };

  constructor(initialSettings?: Partial<PrinterSettings>) {
    if (initialSettings) {
      this.settings = { ...this.settings, ...initialSettings };
    }
    if (CatPrinterService.isSupported()) {
      this.log('Web Bluetooth API ready. Click Connect to pair with your printer.');
    } else {
      this.log('Web Bluetooth API is not available in this browser. Use Google Chrome, Edge, or Brave.');
    }
  }

  /**
   * Checks whether the current browser context supports Web Bluetooth (`navigator.bluetooth`).
   */
  public static isSupported(): boolean {
    return typeof navigator !== 'undefined' && 'bluetooth' in navigator && Boolean(navigator.bluetooth);
  }

  public get connectionState(): PrinterConnectionState {
    return this._connectionState;
  }

  public get connectedPrinterName(): string | null {
    return this._device?.name || (this._connectionState === 'connected' ? this.settings.targetDeviceName : null);
  }

  public get printProgress(): number {
    return this._printProgress;
  }

  public get logMessages(): ReadonlyArray<string> {
    return this._logMessages;
  }

  public on<K extends EventKey>(event: K, listener: CatPrinterEvents[K]): () => void {
    this._listeners[event].add(listener);
    return () => {
      this._listeners[event].delete(listener);
    };
  }

  public clearLogs(): void {
    this._logMessages = [];
    for (const listener of this._listeners.log) {
      listener('', this._logMessages);
    }
  }

  public log(message: string): void {
    const time = new Date().toLocaleTimeString([], {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    const entry = `[${time}] ${message}`;
    this._logMessages.push(entry);
    if (this._logMessages.length > 120) {
      this._logMessages.shift();
    }
    for (const listener of this._listeners.log) {
      listener(entry, this._logMessages);
    }
  }

  private setConnectionState(state: PrinterConnectionState): void {
    this._connectionState = state;
    const name = this.connectedPrinterName;
    for (const listener of this._listeners.stateChange) {
      listener(state, name);
    }
  }

  private setProgress(value: number): void {
    this._printProgress = Math.max(0, Math.min(1, value));
    for (const listener of this._listeners.progress) {
      listener(this._printProgress);
    }
  }

  /**
   * Prompts the user with Chrome's Web Bluetooth chooser and connects to the selected printer.
   */
  public async requestAndConnect(options?: {
    acceptAllDevices?: boolean;
    targetNamePrefix?: string;
  }): Promise<void> {
    if (!CatPrinterService.isSupported()) {
      const msg = 'Web Bluetooth is not supported in this browser. Please open in Google Chrome or Microsoft Edge.';
      this.log(`Error: ${msg}`);
      throw new Error(msg);
    }

    const optionalServices = [
      CatPrinterService.SERVICE_UUID_AE30,
      CatPrinterService.SERVICE_UUID_AF30,
    ];

    this.setConnectionState('scanning');

    try {
      let requestOptions: RequestDeviceOptions;

      if (options?.acceptAllDevices) {
        this.log('Opening Bluetooth chooser (showing all BLE devices)...');
        requestOptions = {
          acceptAllDevices: true,
          optionalServices,
        };
      } else if (options?.targetNamePrefix && options.targetNamePrefix.trim().length > 0) {
        const prefix = options.targetNamePrefix.trim();
        this.log(`Scanning for '${prefix}' or compatible Cat/FunPrint printers...`);
        const filters: BluetoothLEScanFilter[] = [
          { namePrefix: prefix },
          { services: [CatPrinterService.SERVICE_UUID_AE30] },
          { services: [CatPrinterService.SERVICE_UUID_AF30] },
          ...CatPrinterService.KNOWN_NAME_PREFIXES.map((p) => ({ namePrefix: p })),
        ];
        requestOptions = {
          filters,
          optionalServices,
        };
      } else {
        this.log('Scanning for FunPrint / Cat BLE printers...');
        const filters: BluetoothLEScanFilter[] = [
          { services: [CatPrinterService.SERVICE_UUID_AE30] },
          { services: [CatPrinterService.SERVICE_UUID_AF30] },
          ...CatPrinterService.KNOWN_NAME_PREFIXES.map((p) => ({ namePrefix: p })),
        ];
        requestOptions = {
          filters,
          optionalServices,
        };
      }

      const device = await navigator.bluetooth.requestDevice(requestOptions);
      await this.connectToDevice(device);
    } catch (err) {
      this.setConnectionState(this._server?.connected ? 'connected' : 'disconnected');
      const errMessage = err instanceof Error ? err.message : String(err);
      if (errMessage.includes('User cancelled') || errMessage.includes('chooser')) {
        this.log('Bluetooth device selection cancelled.');
        return;
      }
      this.log(`Connection failed: ${errMessage}`);
      throw err;
    }
  }

  /**
   * Connects to an already obtained `BluetoothDevice` instance and discovers GATT services/characteristics.
   */
  public async connectToDevice(device: BluetoothDevice): Promise<void> {
    if (this._device && this._device !== device) {
      this.disconnect();
    }

    this._device = device;
    device.removeEventListener('gattserverdisconnected', this._boundOnDisconnected);
    device.addEventListener('gattserverdisconnected', this._boundOnDisconnected);

    const displayName = device.name || this.settings.targetDeviceName || 'Thermal Printer';
    this.setConnectionState('connecting');
    this.log(`Connecting to '${displayName}'...`);

    if (!device.gatt) {
      this.setConnectionState('disconnected');
      throw new Error('Selected Bluetooth device does not expose a GATT server.');
    }

    const server = await device.gatt.connect();
    this._server = server;
    this.log(`GATT connected to '${displayName}'. Discovering printer services...`);

    // Discover primary service (0xAE30 or 0xAF30 or fallback to all primary services)
    let targetService: BluetoothRemoteGATTService | null = null;
    for (const uuid of [CatPrinterService.SERVICE_UUID_AE30, CatPrinterService.SERVICE_UUID_AF30]) {
      try {
        targetService = await server.getPrimaryService(uuid);
        if (targetService) {
          this.log(`Discovered primary service: ${uuid.slice(4, 8).toUpperCase()}`);
          break;
        }
      } catch {
        // Try next UUID
      }
    }

    let characteristics: BluetoothRemoteGATTCharacteristic[] = [];
    if (targetService) {
      characteristics = await targetService.getCharacteristics();
    } else {
      this.log('Standard service UUID filter empty, querying all primary services...');
      const services = await server.getPrimaryServices();
      for (const svc of services) {
        this.log(`Inspecting service: ${svc.uuid}`);
        const chars = await svc.getCharacteristics();
        characteristics.push(...chars);
      }
    }

    this._writeCharacteristic = null;
    this._notifyCharacteristic = null;

    for (const char of characteristics) {
      const uuidLower = char.uuid.toLowerCase();
      this.log(
        `Characteristic ${uuidLower.slice(4, 8).toUpperCase()} [writeNoResp=${char.properties.writeWithoutResponse}, write=${char.properties.write}, notify=${char.properties.notify}]`
      );

      if (uuidLower === CatPrinterService.CHAR_UUID_AE01 || uuidLower.includes('ae01')) {
        this._writeCharacteristic = char;
        this._preferWriteWithoutResponse = Boolean(char.properties.writeWithoutResponse);
        this.log(
          `Target Write Characteristic set to 0xAE01 (${
            this._preferWriteWithoutResponse ? 'writeWithoutResponse' : 'writeWithResponse'
          }).`
        );
      } else if (
        !this._writeCharacteristic &&
        (char.properties.writeWithoutResponse || char.properties.write)
      ) {
        this._writeCharacteristic = char;
        this._preferWriteWithoutResponse = Boolean(char.properties.writeWithoutResponse);
        this.log(`Fallback Write Characteristic set to ${char.uuid}.`);
      }

      if (uuidLower === CatPrinterService.CHAR_UUID_AE02 || char.properties.notify) {
        this._notifyCharacteristic = char;
      }
    }

    if (!this._writeCharacteristic) {
      this.disconnect();
      throw new Error('Could not find writable BLE characteristic (0xAE01) on printer.');
    }

    if (this._notifyCharacteristic) {
      try {
        await this._notifyCharacteristic.startNotifications();
        this._notifyCharacteristic.removeEventListener(
          'characteristicvaluechanged',
          this._boundOnNotification
        );
        this._notifyCharacteristic.addEventListener(
          'characteristicvaluechanged',
          this._boundOnNotification
        );
        this.log(`Subscribed to notifications on 0xAE02.`);
      } catch (notifyErr) {
        this.log(
          `Note: Could not enable notifications (${
            notifyErr instanceof Error ? notifyErr.message : String(notifyErr)
          })`
        );
      }
    }

    this.setConnectionState('connected');
    this.log(`Printer '${displayName}' is connected and ready to print!`);
  }

  public disconnect(): void {
    if (this._notifyCharacteristic) {
      this._notifyCharacteristic.removeEventListener(
        'characteristicvaluechanged',
        this._boundOnNotification
      );
      this._notifyCharacteristic = null;
    }
    if (this._device) {
      this._device.removeEventListener('gattserverdisconnected', this._boundOnDisconnected);
      if (this._device.gatt?.connected) {
        this.log(`Disconnecting from '${this._device.name || 'Printer'}'...`);
        this._device.gatt.disconnect();
      }
    }
    this._writeCharacteristic = null;
    this._server = null;
    this.setConnectionState('disconnected');
  }

  private handleDisconnected(): void {
    const name = this._device?.name || 'Printer';
    this._writeCharacteristic = null;
    this._notifyCharacteristic = null;
    this._server = null;
    this.setConnectionState('disconnected');
    this.log(`Disconnected from '${name}'.`);
  }

  /**
   * Writes a serialized packet to the active BLE characteristic.
   */
  private async writePacket(data: Uint8Array): Promise<void> {
    const char = this._writeCharacteristic;
    if (!char || !this._server?.connected) {
      throw new Error('Printer is not connected.');
    }

    const buffer = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer;
    if (this._preferWriteWithoutResponse && typeof char.writeValueWithoutResponse === 'function') {
      await char.writeValueWithoutResponse(buffer);
    } else if (typeof char.writeValueWithResponse === 'function') {
      await char.writeValueWithResponse(buffer);
    } else {
      await char.writeValue(buffer);
    }
  }

  /**
   * Sends a full print job with initialization handshake, paced row transmission, and paper feed.
   */
  public async printLines(
    lines: ReadonlyArray<Uint8Array>,
    optionsOverride?: Partial<Pick<PrinterSettings, 'feedAfterPrint'>>
  ): Promise<void> {
    if (this._connectionState !== 'connected' || !this._writeCharacteristic) {
      const msg = 'No printer connected or write characteristic unavailable.';
      this.log(`Error: ${msg}`);
      throw new Error(msg);
    }

    const feedAfter = optionsOverride?.feedAfterPrint ?? this.settings.feedAfterPrint;
    const {
      energyLevel,
      retractBeforePrint,
      retractAmount,
      feedAmount,
      feedMode,
      lineDelayMs,
    } = this.settings;

    this.setConnectionState('printing');
    this.setProgress(0);
    this._isPrintingCancelled = false;
    this.log(`Starting print job (${lines.length} lines)...`);

    try {
      // 1. Send initialization handshake
      const initPackets = CatPrinterCommand.initializationSequence(energyLevel);
      for (const packet of initPackets) {
        await this.writePacket(packet.serialize());
        await sleep(10);
      }

      // 1b. Retract paper if requested (pulls paper back from tear bar to thermal head)
      if (retractBeforePrint && retractAmount > 0) {
        this.log(`Retracting paper by ${retractAmount} steps before printing...`);
        const retractPacket = CatPrinterCommand.retractPaper(retractAmount).serialize();
        await this.writePacket(retractPacket);
        await sleep(200);
      }

      // 2. Stream bitmap lines with pacing
      const trailingFeed =
        feedAfter && feedAmount > 0 && feedMode === 'blankLines' ? feedAmount : 0;
      const totalLines = Math.max(1, lines.length + trailingFeed);
      let linesPrinted = 0;

      for (const line of lines) {
        if (this._isPrintingCancelled) {
          this.log('Print job cancelled by user.');
          this.setConnectionState('connected');
          return;
        }

        const packet = CatPrinterCommand.printLine(line).serialize();
        await this.writePacket(packet);

        linesPrinted += 1;
        this.setProgress(linesPrinted / totalLines);

        await sleep(lineDelayMs);
      }

      // 3. Paper feed handling
      if (feedAfter && feedAmount > 0) {
        if (feedMode === 'blankLines') {
          this.log(`Feeding paper via ${feedAmount} blank lines (FunPrint / MX workaround)...`);
          const blankPacket = CatPrinterCommand.blankLine().serialize();
          for (let i = 0; i < feedAmount; i++) {
            if (this._isPrintingCancelled) {
              break;
            }
            await this.writePacket(blankPacket);
            linesPrinted += 1;
            this.setProgress(linesPrinted / totalLines);
            await sleep(lineDelayMs);
          }
        } else {
          this.log(`Feeding paper via native command (${feedAmount} steps)...`);
          const feedPacket = CatPrinterCommand.feedPaper(feedAmount).serialize();
          await this.writePacket(feedPacket);
          await sleep(200);
        }
      }

      this.setProgress(1.0);
      this.setConnectionState('connected');
      this.log('Print job completed successfully!');
    } catch (err) {
      this.setConnectionState(this._server?.connected ? 'connected' : 'disconnected');
      const errMessage = err instanceof Error ? err.message : String(err);
      this.log(`Print error: ${errMessage}`);
      throw err;
    }
  }

  /**
   * Manually feeds paper forward.
   */
  public async feedPaperNow(): Promise<void> {
    if (this._connectionState !== 'connected' || !this._writeCharacteristic) {
      this.log('Cannot feed: Printer is not connected.');
      return;
    }

    const { feedMode, feedAmount, lineDelayMs } = this.settings;
    this.log(`Feeding paper forward (${feedAmount} ${feedMode === 'blankLines' ? 'lines' : 'steps'})...`);

    if (feedMode === 'blankLines') {
      const blankPacket = CatPrinterCommand.blankLine().serialize();
      for (let i = 0; i < feedAmount; i++) {
        await this.writePacket(blankPacket);
        await sleep(lineDelayMs);
      }
    } else {
      const feedPacket = CatPrinterCommand.feedPaper(feedAmount).serialize();
      await this.writePacket(feedPacket);
    }

    this.log('Paper fed.');
  }

  /**
   * Manually retracts paper backward.
   */
  public async retractPaperNow(): Promise<void> {
    if (this._connectionState !== 'connected' || !this._writeCharacteristic) {
      this.log('Cannot retract: Printer is not connected.');
      return;
    }

    const { retractAmount } = this.settings;
    this.log(`Retracting paper by ${retractAmount} steps...`);
    const retractPacket = CatPrinterCommand.retractPaper(retractAmount).serialize();
    await this.writePacket(retractPacket);
    this.log('Retract command sent.');
  }

  /**
   * Feeds paper forward by the exact label pitch (e.g. 184 dots for 23mm).
   */
  public async advanceLabelNow(pitchDots: number = 184): Promise<void> {
    if (this._connectionState !== 'connected' || !this._writeCharacteristic) {
      this.log('Cannot advance: Printer is not connected.');
      return;
    }

    this.log(`Advancing 1 label pitch (${pitchDots} lines / ~${Math.round(pitchDots / 8)} mm)...`);
    const blankPacket = CatPrinterCommand.blankLine().serialize();
    for (let i = 0; i < pitchDots; i++) {
      await this.writePacket(blankPacket);
      await sleep(this.settings.lineDelayMs);
    }
    this.log('Advanced 1 label pitch.');
  }

  public cancelPrinting(): void {
    this._isPrintingCancelled = true;
  }
}
