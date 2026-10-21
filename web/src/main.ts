import {
  evaluatePaperFit,
  getGapInDots,
  getHeightInDots,
  getPitchInDots,
  PaperPresets,
  STANDARD_PAPER_PRESETS,
  type PaperSize,
} from './engine/paperSize.ts';
import {
  assembleStickerLines,
  canvasToThermalLines,
  createDefaultTypography,
  fitTypographyToHeight,
  generateTestPatternLines,
  renderLinesToPreviewCanvas,
  renderTextToThermalLines,
  trimLeadingBlankLines,
  typographyFittedToHeight,
  type BorderStyle,
  type DitherMode,
  type TextAlignmentMode,
  type TypographyOptions,
  type VerticalAlignmentMode,
} from './engine/thermalRenderer.ts';
import {
  CatPrinterService,
  type FeedMode,
  type PrinterConnectionState,
} from './service/catPrinterService.ts';

const STORAGE_KEY = 'catprint_web_preferences_v1';

interface SavedPreferences {
  targetDeviceName: string;
  selectedPresetId: string;
  customWidthMm: number;
  customHeightMm: number;
  stickerGapMm: number;
  topOffsetMm: number;
  horizontalShiftMm: number;
  stickerVerticalAlignment: VerticalAlignmentMode;
  trimTopMargin: boolean;
  advanceToNextSticker: boolean;
  feedMode: FeedMode;
  feedAmount: number;
  retractAmount: number;
  retractBeforePrint: boolean;
  energyLevel: number;
  lineDelayMs: number;
  typography: TypographyOptions;
}

function getEl<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) {
    throw new Error(`Missing DOM element #${id}`);
  }
  return el as T;
}

function formatTodayDate(): string {
  const now = new Date();
  const dd = String(now.getDate()).padStart(2, '0');
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const yyyy = now.getFullYear();
  return `${dd}.${mm}.${yyyy}`;
}

export function initCatPrintApp(): void {
  const service = new CatPrinterService();

  // Application State
  let sourceMode: 'text' | 'photo' = 'text';
  let selectedPresetId: string = PaperPresets.sticker52x15.id;
  let customWidthMm = 52;
  let customHeightMm = 15;
  let stickerGapMm = 8;
  let topOffsetMm = 0;
  let horizontalShiftMm = 0;
  let stickerVerticalAlignment: VerticalAlignmentMode = 'top';
  let trimTopMargin = true;
  let advanceToNextSticker = true;
  let loadedPhotoImage: HTMLImageElement | null = null;
  let generatedLines: Uint8Array[] = [];

  let typography: TypographyOptions = createDefaultTypography({
    fontSize: 16,
    fontName: 'System',
    isBold: true,
    alignment: 'center',
    lineSpacing: 2,
    horizontalPadding: 8,
    verticalPadding: 6,
    ditherMode: 'threshold',
    threshold: 0.6,
    borderStyle: 'none',
    horizontalOffset: -4,
  });

  // Load saved preferences from localStorage
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw) as Partial<SavedPreferences>;
      if (parsed.targetDeviceName) service.settings.targetDeviceName = parsed.targetDeviceName;
      if (parsed.selectedPresetId) selectedPresetId = parsed.selectedPresetId;
      if (typeof parsed.customWidthMm === 'number') customWidthMm = parsed.customWidthMm;
      if (typeof parsed.customHeightMm === 'number') customHeightMm = parsed.customHeightMm;
      if (typeof parsed.stickerGapMm === 'number') stickerGapMm = parsed.stickerGapMm;
      if (typeof parsed.topOffsetMm === 'number') topOffsetMm = parsed.topOffsetMm;
      if (typeof parsed.horizontalShiftMm === 'number') horizontalShiftMm = parsed.horizontalShiftMm;
      if (parsed.stickerVerticalAlignment) stickerVerticalAlignment = parsed.stickerVerticalAlignment;
      if (typeof parsed.trimTopMargin === 'boolean') trimTopMargin = parsed.trimTopMargin;
      if (typeof parsed.advanceToNextSticker === 'boolean')
        advanceToNextSticker = parsed.advanceToNextSticker;
      if (parsed.feedMode) service.settings.feedMode = parsed.feedMode;
      if (typeof parsed.feedAmount === 'number') service.settings.feedAmount = parsed.feedAmount;
      if (typeof parsed.retractAmount === 'number')
        service.settings.retractAmount = parsed.retractAmount;
      if (typeof parsed.retractBeforePrint === 'boolean')
        service.settings.retractBeforePrint = parsed.retractBeforePrint;
      if (typeof parsed.energyLevel === 'number') service.settings.energyLevel = parsed.energyLevel;
      if (typeof parsed.lineDelayMs === 'number') service.settings.lineDelayMs = parsed.lineDelayMs;
      if (parsed.typography) {
        typography = { ...typography, ...parsed.typography };
      }
    }
  } catch {
    // Ignore corrupt localStorage
  }

  function savePreferences(): void {
    try {
      const prefs: SavedPreferences = {
        targetDeviceName: service.settings.targetDeviceName,
        selectedPresetId,
        customWidthMm,
        customHeightMm,
        stickerGapMm,
        topOffsetMm,
        horizontalShiftMm,
        stickerVerticalAlignment,
        trimTopMargin,
        advanceToNextSticker,
        feedMode: service.settings.feedMode,
        feedAmount: service.settings.feedAmount,
        retractAmount: service.settings.retractAmount,
        retractBeforePrint: service.settings.retractBeforePrint,
        energyLevel: service.settings.energyLevel,
        lineDelayMs: service.settings.lineDelayMs,
        typography,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch {
      // Ignore storage quota errors
    }
  }

  // DOM Elements
  const bleUnsupportedBanner = getEl<HTMLDivElement>('ble-unsupported-banner');
  const statusIndicator = getEl<HTMLSpanElement>('status-indicator');
  const statusIcon = getEl<HTMLSpanElement>('status-icon');
  const statusText = getEl<HTMLSpanElement>('status-text');
  const btnDisconnect = getEl<HTMLButtonElement>('btn-disconnect');
  const connectControls = getEl<HTMLDivElement>('connect-controls');
  const btnConnectTarget = getEl<HTMLButtonElement>('btn-connect-target');
  const btnConnectTargetLabel = getEl<HTMLSpanElement>('btn-connect-target-label');
  const btnScanAny = getEl<HTMLButtonElement>('btn-scan-any');
  const inputTargetName = getEl<HTMLInputElement>('input-target-name');
  const chkAcceptAll = getEl<HTMLInputElement>('chk-accept-all');

  const segSticker = getEl<HTMLButtonElement>('seg-sticker');
  const segRoll = getEl<HTMLButtonElement>('seg-roll');
  const selectPaperPreset = getEl<HTMLSelectElement>('select-paper-preset');
  const customSizeFields = getEl<HTMLDivElement>('custom-size-fields');
  const inputCustomWidth = getEl<HTMLInputElement>('input-custom-width');
  const inputCustomHeight = getEl<HTMLInputElement>('input-custom-height');
  const stickerControls = getEl<HTMLDivElement>('sticker-controls');
  const inputStickerGap = getEl<HTMLInputElement>('input-sticker-gap');
  const inputTopOffset = getEl<HTMLInputElement>('input-top-offset');
  const inputHShift = getEl<HTMLInputElement>('input-h-shift');
  const chkTrimTop = getEl<HTMLInputElement>('chk-trim-top');
  const chkAdvanceNext = getEl<HTMLInputElement>('chk-advance-next');
  const pitchSummary = getEl<HTMLParagraphElement>('pitch-summary');

  const btnRetractNow = getEl<HTMLButtonElement>('btn-retract-now');
  const btnFeedNow = getEl<HTMLButtonElement>('btn-feed-now');
  const btnAdvanceLabel = getEl<HTMLButtonElement>('btn-advance-label');
  const selectFeedMode = getEl<HTMLSelectElement>('select-feed-mode');
  const inputFeedAmount = getEl<HTMLInputElement>('input-feed-amount');
  const inputRetractAmount = getEl<HTMLInputElement>('input-retract-amount');
  const chkRetractBefore = getEl<HTMLInputElement>('chk-retract-before');
  const rangeEnergy = getEl<HTMLInputElement>('range-energy');
  const labelEnergyVal = getEl<HTMLSpanElement>('label-energy-val');
  const rangeDelay = getEl<HTMLInputElement>('range-delay');
  const labelDelayVal = getEl<HTMLSpanElement>('label-delay-val');

  const printProgressBox = getEl<HTMLDivElement>('print-progress-box');
  const progressLabel = getEl<HTMLSpanElement>('progress-label');
  const printProgressBar = getEl<HTMLProgressElement>('print-progress-bar');
  const btnCancelPrint = getEl<HTMLButtonElement>('btn-cancel-print');
  const btnPrintMain = getEl<HTMLButtonElement>('btn-print-main');
  const btnPrintMainLabel = getEl<HTMLSpanElement>('btn-print-main-label');
  const btnPrintDate = getEl<HTMLButtonElement>('btn-print-date');
  const btnPrintDateLabel = getEl<HTMLSpanElement>('btn-print-date-label');
  const btnPrintTest = getEl<HTMLButtonElement>('btn-print-test');

  const logConsole = getEl<HTMLDivElement>('log-console');
  const btnClearLogs = getEl<HTMLButtonElement>('btn-clear-logs');

  const tabTextMode = getEl<HTMLButtonElement>('tab-text-mode');
  const tabPhotoMode = getEl<HTMLButtonElement>('tab-photo-mode');
  const btnAutofit = getEl<HTMLButtonElement>('btn-autofit');
  const btnSampleSticker = getEl<HTMLButtonElement>('btn-sample-sticker');
  const btnSampleReceipt = getEl<HTMLButtonElement>('btn-sample-receipt');

  const textToolbarGroup = getEl<HTMLDivElement>('text-toolbar-group');
  const selectFont = getEl<HTMLSelectElement>('select-font');
  const rangeFontSize = getEl<HTMLInputElement>('range-font-size');
  const inputFontSize = getEl<HTMLInputElement>('input-font-size');
  const btnBold = getEl<HTMLButtonElement>('btn-bold');
  const selectBorder = getEl<HTMLSelectElement>('select-border');
  const inputLineSpacing = getEl<HTMLInputElement>('input-line-spacing');
  const selectDither = getEl<HTMLSelectElement>('select-dither');
  const thresholdControlItem = getEl<HTMLDivElement>('threshold-control-item');
  const rangeThreshold = getEl<HTMLInputElement>('range-threshold');
  const labelThresholdVal = getEl<HTMLSpanElement>('label-threshold-val');

  const panelTextInput = getEl<HTMLDivElement>('panel-text-input');
  const textareaPrint = getEl<HTMLTextAreaElement>('textarea-print');
  const panelPhotoInput = getEl<HTMLDivElement>('panel-photo-input');
  const photoDropzone = getEl<HTMLLabelElement>('photo-dropzone');
  const filePhotoInput = getEl<HTMLInputElement>('file-photo-input');
  const photoMetaBar = getEl<HTMLDivElement>('photo-meta-bar');
  const photoInfoText = getEl<HTMLSpanElement>('photo-info-text');
  const btnClearPhoto = getEl<HTMLButtonElement>('btn-clear-photo');

  const previewTitle = getEl<HTMLHeadingElement>('preview-title');
  const fitBadge = getEl<HTMLSpanElement>('fit-badge');
  const fitBadgeIcon = getEl<HTMLSpanElement>('fit-badge-icon');
  const fitBadgeText = getEl<HTMLSpanElement>('fit-badge-text');
  const stickerCardFrame = getEl<HTMLDivElement>('sticker-card-frame');
  const stickerPrintableZone = getEl<HTMLDivElement>('sticker-printable-zone');
  const previewCanvas = getEl<HTMLCanvasElement>('thermal-preview-canvas');
  const stickerGapIndicator = getEl<HTMLDivElement>('sticker-gap-indicator');
  const gapLabelMm = getEl<HTMLSpanElement>('gap-label-mm');
  const gapLabelDots = getEl<HTMLSpanElement>('gap-label-dots');

  // Show warning banner if Web Bluetooth is not supported
  if (!CatPrinterService.isSupported()) {
    bleUnsupportedBanner.hidden = false;
  }

  function getCurrentPaper(): PaperSize {
    if (selectedPresetId === 'custom') {
      return {
        id: 'custom',
        name: `Custom (${Math.round(customWidthMm)}×${Math.round(customHeightMm)} mm)`,
        kind: 'sticker',
        widthMm: customWidthMm,
        heightMm: customHeightMm,
        gapMm: stickerGapMm,
      };
    }

    const found =
      STANDARD_PAPER_PRESETS.find((p) => p.id === selectedPresetId) ?? PaperPresets.sticker52x15;
    if (found.kind === 'sticker') {
      return {
        ...found,
        gapMm: stickerGapMm,
      };
    }
    return found;
  }

  function syncControlsFromState(): void {
    inputTargetName.value = service.settings.targetDeviceName;
    btnConnectTargetLabel.textContent = `Connect to ${service.settings.targetDeviceName || 'MX06'}`;

    selectPaperPreset.value = selectedPresetId;
    const paper = getCurrentPaper();
    const isSticker = paper.kind === 'sticker';

    segSticker.classList.toggle('active', isSticker);
    segSticker.setAttribute('aria-pressed', String(isSticker));
    segRoll.classList.toggle('active', !isSticker);
    segRoll.setAttribute('aria-pressed', String(!isSticker));

    customSizeFields.hidden = selectedPresetId !== 'custom';
    stickerControls.hidden = !isSticker;
    btnAutofit.hidden = !isSticker || sourceMode !== 'text';

    inputCustomWidth.value = String(customWidthMm);
    inputCustomHeight.value = String(customHeightMm);
    inputStickerGap.value = String(stickerGapMm);
    inputTopOffset.value = String(topOffsetMm);
    inputHShift.value = String(horizontalShiftMm);
    chkTrimTop.checked = trimTopMargin;
    chkAdvanceNext.checked = advanceToNextSticker;

    document.querySelectorAll<HTMLButtonElement>('[data-valign]').forEach((btn) => {
      const active = btn.dataset.valign === stickerVerticalAlignment;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    selectFeedMode.value = service.settings.feedMode;
    inputFeedAmount.value = String(service.settings.feedAmount);
    inputRetractAmount.value = String(service.settings.retractAmount);
    chkRetractBefore.checked = service.settings.retractBeforePrint;
    rangeEnergy.value = String(service.settings.energyLevel);
    const energyPct = Math.round((service.settings.energyLevel / 0xffff) * 100);
    labelEnergyVal.textContent = `${energyPct}% (0x${service.settings.energyLevel
      .toString(16)
      .toUpperCase()})`;
    rangeDelay.value = String(service.settings.lineDelayMs);
    labelDelayVal.textContent = `${service.settings.lineDelayMs} ms`;

    selectFont.value = typography.fontName;
    rangeFontSize.value = String(typography.fontSize);
    inputFontSize.value = String(typography.fontSize);
    btnBold.classList.toggle('active', typography.isBold);
    btnBold.setAttribute('aria-pressed', String(typography.isBold));
    selectBorder.value = typography.borderStyle;
    inputLineSpacing.value = String(typography.lineSpacing);
    selectDither.value = typography.ditherMode;
    thresholdControlItem.hidden = typography.ditherMode !== 'threshold';
    rangeThreshold.value = String(typography.threshold);
    labelThresholdVal.textContent = `${Math.round(typography.threshold * 100)}%`;

    document.querySelectorAll<HTMLButtonElement>('[data-align]').forEach((btn) => {
      const active = btn.dataset.align === typography.alignment;
      btn.classList.toggle('active', active);
      btn.setAttribute('aria-pressed', String(active));
    });

    btnPrintDateLabel.textContent = `Print Current Date (${formatTodayDate()})`;
  }

  function updatePreview(): void {
    typography.horizontalOffset = -4.0 + horizontalShiftMm * 8.0;

    let lines: Uint8Array[] = [];
    if (sourceMode === 'photo' && loadedPhotoImage) {
      lines = canvasToThermalLines(
        loadedPhotoImage,
        typography.ditherMode,
        typography.threshold
      );
    } else {
      lines = renderTextToThermalLines(textareaPrint.value, typography);
      if (trimTopMargin) {
        const keepPad = typography.borderStyle !== 'none' ? 4 : 0;
        lines = trimLeadingBlankLines(lines, keepPad);
      }
    }

    generatedLines = lines;
    renderLinesToPreviewCanvas(lines, previewCanvas);

    // Update Paper Fit & Stage Layout
    const paper = getCurrentPaper();
    const fit = evaluatePaperFit(paper, lines.length);

    if (paper.kind === 'sticker') {
      const heightMm = paper.heightMm ?? 15;
      const heightDots = getHeightInDots(paper) ?? 120;
      const gapDots = getGapInDots(paper);
      const pitchDots = getPitchInDots(paper) ?? heightDots + gapDots;

      previewTitle.textContent = `DIE-CUT STICKER PREVIEW (${Math.round(
        paper.widthMm
      )} × ${Math.round(heightMm)} mm)`;
      btnPrintMainLabel.textContent = `Print Sticker (${Math.round(paper.widthMm)}×${Math.round(
        heightMm
      )}mm)`;

      pitchSummary.textContent = `Pitch: ${Math.round(
        heightMm + stickerGapMm
      )}mm (${pitchDots} dot lines)`;

      stickerCardFrame.classList.remove('continuous-mode');
      stickerCardFrame.style.minHeight = `${heightDots}px`;

      if (stickerVerticalAlignment === 'center') {
        stickerCardFrame.style.justifyContent = 'center';
      } else if (stickerVerticalAlignment === 'bottom') {
        stickerCardFrame.style.justifyContent = 'flex-end';
      } else {
        stickerCardFrame.style.justifyContent = 'flex-start';
      }

      stickerPrintableZone.style.marginTop =
        topOffsetMm > 0 ? `${Math.round(topOffsetMm * 8)}px` : '0px';

      stickerGapIndicator.hidden = false;
      gapLabelMm.textContent = `${stickerGapMm}mm gap`;
      gapLabelDots.textContent = String(gapDots);

      fitBadge.dataset.fits = String(fit.fits);
      if (fit.fits) {
        fitBadgeIcon.textContent = '✓';
        fitBadgeText.textContent = `Fits (${fit.contentLines}/${fit.capacityLines} lines)`;
      } else {
        fitBadgeIcon.textContent = '⚠️';
        fitBadgeText.textContent = `Overflow +${fit.overflowLines} lines (${fit.contentLines}/${fit.capacityLines})`;
      }
    } else {
      previewTitle.textContent = `CONTINUOUS RECEIPT PREVIEW (384px / 57mm)`;
      btnPrintMainLabel.textContent = `Print Receipt (${lines.length} lines)`;
      stickerCardFrame.classList.add('continuous-mode');
      stickerCardFrame.style.minHeight = `${Math.max(60, lines.length)}px`;
      stickerCardFrame.style.justifyContent = 'flex-start';
      stickerPrintableZone.style.marginTop = '0px';
      stickerGapIndicator.hidden = true;

      fitBadge.dataset.fits = 'true';
      fitBadgeIcon.textContent = '🧾';
      fitBadgeText.textContent = `${lines.length} lines (~${Math.round(lines.length / 8)} mm)`;
    }

    savePreferences();
  }

  function renderLogs(allLogs: ReadonlyArray<string>): void {
    logConsole.innerHTML = '';
    for (const entry of allLogs) {
      const div = document.createElement('div');
      div.className = 'log-line';
      div.textContent = entry;
      logConsole.appendChild(div);
    }
    logConsole.scrollTop = logConsole.scrollHeight;
  }

  function updateConnectionUI(state: PrinterConnectionState, printerName: string | null): void {
    statusIndicator.dataset.state = state;

    switch (state) {
      case 'connected':
        statusIcon.textContent = '●';
        statusText.textContent = printerName ? `Connected: ${printerName}` : 'Connected';
        btnDisconnect.hidden = false;
        connectControls.hidden = true;
        printProgressBox.hidden = true;
        break;
      case 'printing':
        statusIcon.textContent = '🖨️';
        statusText.textContent = 'Printing...';
        btnDisconnect.hidden = false;
        connectControls.hidden = true;
        printProgressBox.hidden = false;
        break;
      case 'scanning':
        statusIcon.textContent = '◌';
        statusText.textContent = 'Scanning...';
        btnDisconnect.hidden = true;
        connectControls.hidden = false;
        printProgressBox.hidden = true;
        break;
      case 'connecting':
        statusIcon.textContent = '◌';
        statusText.textContent = 'Connecting...';
        btnDisconnect.hidden = true;
        connectControls.hidden = false;
        printProgressBox.hidden = true;
        break;
      case 'disconnected':
      default:
        statusIcon.textContent = '○';
        statusText.textContent = 'Disconnected';
        btnDisconnect.hidden = true;
        connectControls.hidden = false;
        printProgressBox.hidden = true;
        break;
    }

    const isBusy = state === 'printing' || state === 'connecting' || state === 'scanning';
    btnPrintMain.disabled = isBusy;
    btnPrintDate.disabled = isBusy;
    btnPrintTest.disabled = isBusy;
    btnRetractNow.disabled = state !== 'connected';
    btnFeedNow.disabled = state !== 'connected';
    btnAdvanceLabel.disabled = state !== 'connected';
  }

  // Subscribe to service events
  service.on('stateChange', (state, name) => {
    updateConnectionUI(state, name);
  });

  service.on('progress', (progress) => {
    const pct = Math.round(progress * 100);
    printProgressBar.value = pct;
    progressLabel.textContent = `Printing... ${pct}%`;
  });

  service.on('log', (_entry, allLogs) => {
    renderLogs(allLogs);
  });

  // Initial log render
  renderLogs(service.logMessages);
  updateConnectionUI(service.connectionState, service.connectedPrinterName);

  // Connection Event Handlers
  inputTargetName.addEventListener('input', () => {
    service.settings.targetDeviceName = inputTargetName.value.trim() || 'MX06';
    btnConnectTargetLabel.textContent = `Connect to ${service.settings.targetDeviceName}`;
    savePreferences();
  });

  btnConnectTarget.addEventListener('click', async () => {
    try {
      await service.requestAndConnect({
        acceptAllDevices: chkAcceptAll.checked,
        targetNamePrefix: service.settings.targetDeviceName,
      });
    } catch {
      // Logged in service
    }
  });

  btnScanAny.addEventListener('click', async () => {
    try {
      await service.requestAndConnect({
        acceptAllDevices: chkAcceptAll.checked,
      });
    } catch {
      // Logged in service
    }
  });

  btnDisconnect.addEventListener('click', () => {
    service.disconnect();
  });

  // Paper Media Event Handlers
  segSticker.addEventListener('click', () => {
    if (selectedPresetId === PaperPresets.continuous57.id) {
      selectedPresetId = PaperPresets.sticker52x15.id;
    }
    syncControlsFromState();
    updatePreview();
  });

  segRoll.addEventListener('click', () => {
    selectedPresetId = PaperPresets.continuous57.id;
    syncControlsFromState();
    updatePreview();
  });

  selectPaperPreset.addEventListener('change', () => {
    selectedPresetId = selectPaperPreset.value;
    const preset = STANDARD_PAPER_PRESETS.find((p) => p.id === selectedPresetId);
    if (preset && preset.kind === 'sticker') {
      stickerGapMm = preset.gapMm;
    }
    syncControlsFromState();
    updatePreview();
  });

  inputCustomWidth.addEventListener('input', () => {
    customWidthMm = Math.max(20, Math.min(58, Number(inputCustomWidth.value) || 52));
    updatePreview();
  });

  inputCustomHeight.addEventListener('input', () => {
    customHeightMm = Math.max(8, Math.min(150, Number(inputCustomHeight.value) || 15));
    updatePreview();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-valign]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const val = btn.dataset.valign as VerticalAlignmentMode | undefined;
      if (val) {
        stickerVerticalAlignment = val;
        syncControlsFromState();
        updatePreview();
      }
    });
  });

  inputStickerGap.addEventListener('input', () => {
    stickerGapMm = Math.max(0, Math.min(25, Number(inputStickerGap.value) || 0));
    updatePreview();
  });

  inputTopOffset.addEventListener('input', () => {
    topOffsetMm = Math.max(-10, Math.min(10, Number(inputTopOffset.value) || 0));
    updatePreview();
  });

  inputHShift.addEventListener('input', () => {
    horizontalShiftMm = Math.max(-5, Math.min(5, Number(inputHShift.value) || 0));
    updatePreview();
  });

  chkTrimTop.addEventListener('change', () => {
    trimTopMargin = chkTrimTop.checked;
    updatePreview();
  });

  chkAdvanceNext.addEventListener('change', () => {
    advanceToNextSticker = chkAdvanceNext.checked;
    savePreferences();
  });

  // Hardware & Feed Calibration Handlers
  btnRetractNow.addEventListener('click', () => {
    void service.retractPaperNow();
  });

  btnFeedNow.addEventListener('click', () => {
    void service.feedPaperNow();
  });

  btnAdvanceLabel.addEventListener('click', () => {
    const paper = getCurrentPaper();
    const pitch = getPitchInDots(paper) ?? 184;
    void service.advanceLabelNow(pitch);
  });

  selectFeedMode.addEventListener('change', () => {
    service.settings.feedMode = selectFeedMode.value as FeedMode;
    savePreferences();
  });

  inputFeedAmount.addEventListener('input', () => {
    service.settings.feedAmount = Math.max(0, Math.min(400, Number(inputFeedAmount.value) || 80));
    savePreferences();
  });

  inputRetractAmount.addEventListener('input', () => {
    service.settings.retractAmount = Math.max(
      0,
      Math.min(400, Number(inputRetractAmount.value) || 80)
    );
    savePreferences();
  });

  chkRetractBefore.addEventListener('change', () => {
    service.settings.retractBeforePrint = chkRetractBefore.checked;
    savePreferences();
  });

  rangeEnergy.addEventListener('input', () => {
    service.settings.energyLevel = Number(rangeEnergy.value) || 0x7000;
    syncControlsFromState();
    savePreferences();
  });

  rangeDelay.addEventListener('input', () => {
    service.settings.lineDelayMs = Number(rangeDelay.value) || 15;
    syncControlsFromState();
    savePreferences();
  });

  // Mode Tabs (Text vs Photo)
  tabTextMode.addEventListener('click', () => {
    sourceMode = 'text';
    tabTextMode.classList.add('active');
    tabTextMode.setAttribute('aria-selected', 'true');
    tabPhotoMode.classList.remove('active');
    tabPhotoMode.setAttribute('aria-selected', 'false');
    panelTextInput.hidden = false;
    panelPhotoInput.hidden = true;
    textToolbarGroup.hidden = false;
    syncControlsFromState();
    updatePreview();
  });

  tabPhotoMode.addEventListener('click', () => {
    sourceMode = 'photo';
    tabPhotoMode.classList.add('active');
    tabPhotoMode.setAttribute('aria-selected', 'true');
    tabTextMode.classList.remove('active');
    tabTextMode.setAttribute('aria-selected', 'false');
    panelTextInput.hidden = true;
    panelPhotoInput.hidden = false;
    textToolbarGroup.hidden = true;
    typography.ditherMode = 'floydSteinberg';
    syncControlsFromState();
    updatePreview();
  });

  // Photo Upload & Drag-and-Drop
  function handleImageFile(file: File): void {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        loadedPhotoImage = img;
        photoMetaBar.hidden = false;
        photoInfoText.textContent = `${file.name} (${img.naturalWidth}×${img.naturalHeight}px → 384px thermal)`;
        updatePreview();
      };
      if (typeof reader.result === 'string') {
        img.src = reader.result;
      }
    };
    reader.readAsDataURL(file);
  }

  filePhotoInput.addEventListener('change', () => {
    const file = filePhotoInput.files?.[0];
    if (file) {
      handleImageFile(file);
    }
  });

  photoDropzone.addEventListener('dragover', (e) => {
    e.preventDefault();
    photoDropzone.classList.add('dragover');
  });

  photoDropzone.addEventListener('dragleave', () => {
    photoDropzone.classList.remove('dragover');
  });

  photoDropzone.addEventListener('drop', (e) => {
    e.preventDefault();
    photoDropzone.classList.remove('dragover');
    const file = e.dataTransfer?.files?.[0];
    if (file && file.type.startsWith('image/')) {
      handleImageFile(file);
    }
  });

  btnClearPhoto.addEventListener('click', () => {
    loadedPhotoImage = null;
    filePhotoInput.value = '';
    photoMetaBar.hidden = true;
    updatePreview();
  });

  // Typography Toolbar Event Handlers
  selectFont.addEventListener('change', () => {
    typography.fontName = selectFont.value;
    updatePreview();
  });

  rangeFontSize.addEventListener('input', () => {
    typography.fontSize = Number(rangeFontSize.value) || 16;
    inputFontSize.value = String(typography.fontSize);
    updatePreview();
  });

  inputFontSize.addEventListener('input', () => {
    const val = Math.max(8, Math.min(96, Number(inputFontSize.value) || 16));
    typography.fontSize = val;
    rangeFontSize.value = String(Math.min(64, val));
    updatePreview();
  });

  btnBold.addEventListener('click', () => {
    typography.isBold = !typography.isBold;
    syncControlsFromState();
    updatePreview();
  });

  document.querySelectorAll<HTMLButtonElement>('[data-align]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const align = btn.dataset.align as TextAlignmentMode | undefined;
      if (align) {
        typography.alignment = align;
        syncControlsFromState();
        updatePreview();
      }
    });
  });

  selectBorder.addEventListener('change', () => {
    typography.borderStyle = selectBorder.value as BorderStyle;
    updatePreview();
  });

  inputLineSpacing.addEventListener('input', () => {
    typography.lineSpacing = Math.max(0, Math.min(24, Number(inputLineSpacing.value) || 0));
    updatePreview();
  });

  selectDither.addEventListener('change', () => {
    typography.ditherMode = selectDither.value as DitherMode;
    syncControlsFromState();
    updatePreview();
  });

  rangeThreshold.addEventListener('input', () => {
    typography.threshold = Number(rangeThreshold.value) || 0.6;
    syncControlsFromState();
    updatePreview();
  });

  textareaPrint.addEventListener('input', () => {
    updatePreview();
  });

  // Templates & Auto-Fit
  btnAutofit.addEventListener('click', () => {
    const paper = getCurrentPaper();
    const targetDots = getHeightInDots(paper);
    if (!targetDots) return;

    const fitted = fitTypographyToHeight(textareaPrint.value, typography, targetDots);
    typography.fontSize = fitted.fontSize;
    typography.lineSpacing = fitted.lineSpacing;
    typography.verticalPadding = fitted.verticalPadding;
    syncControlsFromState();
    updatePreview();
    service.log(`Auto-fitted text to ${targetDots} dots (font size: ${typography.fontSize}px).`);
  });

  btnSampleSticker.addEventListener('click', () => {
    sourceMode = 'text';
    tabTextMode.click();
    selectedPresetId = PaperPresets.sticker52x15.id;
    textareaPrint.value = `CAT PRINTER • MX06\nSticker: 52 × 15 mm\nStatus: READY [OK]`;
    typography.fontSize = 16;
    typography.lineSpacing = 2;
    typography.verticalPadding = 6;
    typography.alignment = 'center';
    typography.borderStyle = 'rounded';
    syncControlsFromState();
    updatePreview();
  });

  btnSampleReceipt.addEventListener('click', () => {
    sourceMode = 'text';
    tabTextMode.click();
    selectedPresetId = PaperPresets.continuous57.id;
    textareaPrint.value = [
      'HELLO FUNPRINT WEB!',
      '========================',
      `Date: ${new Date().toLocaleString()}`,
      '',
      '[x] Chrome Web Bluetooth',
      '[x] 384-dot Bitmap Engine',
      '[x] FunPrint MX Workaround',
      '[x] GitHub Pages Static App',
      '',
      'Ready to print stickers, notes,',
      'and receipts from your browser!',
    ].join('\n');
    typography.fontSize = 18;
    typography.lineSpacing = 3;
    typography.verticalPadding = 8;
    typography.alignment = 'left';
    typography.borderStyle = 'none';
    syncControlsFromState();
    updatePreview();
  });

  // Helper to ensure connection before printing (auto-opens Bluetooth chooser if disconnected)
  async function ensureConnectedForPrint(): Promise<boolean> {
    if (service.connectionState === 'connected') {
      return true;
    }
    try {
      await service.requestAndConnect({
        acceptAllDevices: chkAcceptAll.checked,
        targetNamePrefix: service.settings.targetDeviceName,
      });
      return (service.connectionState as PrinterConnectionState) === 'connected';
    } catch {
      return false;
    }
  }

  // Primary Print Action
  btnPrintMain.addEventListener('click', async () => {
    if (generatedLines.length === 0) {
      service.log('Nothing to print.');
      return;
    }

    const connected = await ensureConnectedForPrint();
    if (!connected) return;

    const paper = getCurrentPaper();
    let linesToSend: Uint8Array[];
    let feedAfterPrint: boolean;

    if (paper.kind === 'sticker') {
      feedAfterPrint = false; // Sticker assembly handles exact pitch & gap advance
      linesToSend = assembleStickerLines({
        contentLines: generatedLines,
        paperSize: paper,
        verticalAlignment: stickerVerticalAlignment,
        topOffsetDots: Math.round(topOffsetMm * 8),
        advanceToNextLabel: advanceToNextSticker,
      });
    } else {
      feedAfterPrint = true;
      linesToSend = generatedLines;
    }

    try {
      await service.printLines(linesToSend, { feedAfterPrint });
    } catch {
      // Error logged in service
    }
  });

  // 1-Click Print Current Date Action
  btnPrintDate.addEventListener('click', async () => {
    const dateStr = formatTodayDate();
    const paper = getCurrentPaper();
    const targetDots = getHeightInDots(paper) ?? 80;

    const dateTypography = typographyFittedToHeight({
      text: dateStr,
      targetDots,
      maxFontSize: 38,
      minFontSize: 12,
      borderStyle: typography.borderStyle,
      horizontalOffset: typography.horizontalOffset,
    });

    let rawLines = renderTextToThermalLines(dateStr, dateTypography);
    const keepPad = typography.borderStyle !== 'none' ? 4 : 0;
    rawLines = trimLeadingBlankLines(rawLines, keepPad);

    // Update editor & preview so user sees the fitted date
    sourceMode = 'text';
    textareaPrint.value = dateStr;
    typography.fontSize = dateTypography.fontSize;
    typography.isBold = true;
    typography.alignment = 'center';
    syncControlsFromState();
    updatePreview();

    const connected = await ensureConnectedForPrint();
    if (!connected) return;

    let linesToSend: Uint8Array[];
    let feedAfterPrint: boolean;

    if (paper.kind === 'sticker') {
      feedAfterPrint = false;
      linesToSend = assembleStickerLines({
        contentLines: rawLines,
        paperSize: paper,
        verticalAlignment: 'center',
        topOffsetDots: Math.round(topOffsetMm * 8),
        advanceToNextLabel: true,
      });
    } else {
      feedAfterPrint = true;
      linesToSend = rawLines;
    }

    try {
      await service.printLines(linesToSend, { feedAfterPrint });
    } catch {
      // Error logged in service
    }
  });

  // Print Hardware Test Pattern
  btnPrintTest.addEventListener('click', async () => {
    const patternLines = generateTestPatternLines();
    renderLinesToPreviewCanvas(patternLines, previewCanvas);

    const connected = await ensureConnectedForPrint();
    if (!connected) return;

    try {
      await service.printLines(patternLines, { feedAfterPrint: true });
    } catch {
      // Error logged in service
    }
  });

  btnCancelPrint.addEventListener('click', () => {
    service.cancelPrinting();
  });

  btnClearLogs.addEventListener('click', () => {
    service.clearLogs();
  });

  // Initialize UI
  syncControlsFromState();
  updatePreview();
}

if (typeof document !== 'undefined') {
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => initCatPrintApp());
  } else {
    initCatPrintApp();
  }
}
