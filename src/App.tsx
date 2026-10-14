import i18n, { normalizeLanguage, translateMessage as display, useUiTranslation } from './i18n';
import { uiMessage as m, messageFromError } from './messages';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { version } from '../package.json';
import type { DisplayMessage, Language as UiLanguage } from './types';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Collapse, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Paper, Snackbar, Stack, Switch, Tab, Tabs, TextField, ThemeProvider, Tooltip, Typography } from '@mui/material';
import { Apps, Add, ChevronRight, DarkMode, FolderOpen, LightMode, Refresh, Search, Settings as SettingsIcon, Undo, ExpandMore, Language } from '@mui/icons-material';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from './api';
import type { AppEntry, Integration, Settings } from './types';
import { makeTheme } from './theme';
import { readRetryDelay, synchronize, SynchronizationFailure, ROUTING_REVISION } from './automation';
import { applicationStatus, readWorkspace, resumeAfterRoutingChange, routingFingerprint, settingsAfterConnection } from './workflow';
import { diagnoseApp } from './routingDiagnostics';
import type { RoutingSnapshot } from './routingDiagnostics';
import WebsitePanel from './WebsitePanel';
import { websiteDomains } from './websites';

export default function App() {
  const t = useUiTranslation();
  const preferredLanguage = useRef<UiLanguage>('zh-CN');
  const pendingLanguageSave = useRef(false);
  const [preferenceError, setPreferenceError] = useState<DisplayMessage>('');
  const operation = useRef(false);
  const failedAutomatic = useRef('');
  const readFailures = useRef(0);
  const pendingSettingsSave = useRef(false);
  const [automaticError, setAutomaticError] = useState<DisplayMessage>('');
  const [writeError, setWriteError] = useState<DisplayMessage>('');
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const [settings, setSettings] = useState<Settings>({ selected: [], websites: [], language: 'zh-CN', configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' });
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [connection, setConnection] = useState<Integration>();
  const [connectionChecking, setConnectionChecking] = useState(api.desktop);
  const [connectionError, setConnectionError] = useState<DisplayMessage>('');
  const [busy, setBusy] = useState<DisplayMessage>(m('busy.reading'));
  const [error, setError] = useState<DisplayMessage>('');
  const [toast, setToast] = useState<DisplayMessage>('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState('apps');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'apply' | 'remove' | null>(null);
  const [result, setResult] = useState<DisplayMessage>('');
  const [ready, setReady] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RoutingSnapshot>();
  const [diagnosticError, setDiagnosticError] = useState<DisplayMessage>('');
  const [draftDir, setDraftDir] = useState('');
  const theme = useMemo(() => makeTheme(settings.dark, normalizeLanguage(settings.language)), [settings.dark, settings.language]);
  const reconnecting = connectionChecking || (!connection && !!connectionError);
  const status = applicationStatus(settings, connection, api.desktop, reconnecting, !!writeError);
  const blocked = !!busy || automaticBusy;
  const selected = useMemo(() => new Map(settings.selected.map(a => [a.id, a])), [settings.selected]);
  const combined = useMemo(() => {
    const byId = new Map(apps.map(a => [a.id, a]));
    settings.selected.forEach(a => {
      const live = byId.get(a.id);
      byId.set(a.id, { ...a, running: live?.running ?? false });
    });
    return [...byId.values()].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name, settings.language));
  }, [apps, settings.selected, selected, settings.language]);
  const filtered = combined.filter(a => (tab !== 1 || a.running) && (tab !== 2 || selected.has(a.id)) && `${a.name} ${a.path} ${a.processes.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const count = new Set(settings.selected.flatMap(a => a.processes)).size;
  const websites = websiteDomains(settings.websites);
  async function initialize(isActive = () => true) {
    setBusy(m('busy.reading')); setError(''); setConnectionChecking(api.desktop); setConnectionError('');
    try {
      const loaded = await api.loadSettings();
      if (!isActive()) return;
      const stored = { ...loaded, language: normalizeLanguage(loaded.language) };
      preferredLanguage.current = stored.language;
      await i18n.changeLanguage(stored.language);
      if (!isActive()) return;
      setSettings(stored); setDraftDir(stored.configDir);
      const workspace = await readWorkspace(() => Promise.resolve(stored), api.scanApps, stored => api.integration(stored.configDir), detected => {
        if (!isActive()) return;
        setConnectionChecking(false);
        if (detected.status === 'fulfilled') { setConnection(detected.value); setConnectionError(''); }
        else setConnectionError(m('error.detect', { error: messageFromError(detected.reason) }));
      });
      if (!isActive()) return;
      let next = workspace.settings;
      const errors: DisplayMessage[] = [];
      try { next = { ...next, selected: await api.refreshSelected(next.selected) }; }
      catch (e) { setAutomaticError(m('error.refresh', { error: messageFromError(e) })); }
      if (!isActive()) return;
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(m('error.scan', { error: messageFromError(workspace.apps.reason) }));
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
      }
      setSettings({ ...next, language: preferredLanguage.current }); setDraftDir(next.configDir); setReady(true);
      if (errors.length) setError(m('error.multiple', { errors }));
      if (JSON.stringify(next) !== JSON.stringify(workspace.settings)) {
        try { await api.saveSettings({ ...next, language: preferredLanguage.current }); }
        catch (e) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setWriteError(m('error.save', { error: messageFromError(e) })); }
      }
    } catch (e) { if (isActive()) setError(messageFromError(e)); }
    finally { if (isActive()) { setBusy(''); setConnectionChecking(false); } }
  }
  useEffect(() => { let active = true; void initialize(() => active); return () => { active = false; }; }, []);
  useEffect(() => {
    if (!ready || !api.desktop) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const fingerprint = routingFingerprint(settings);
    async function cycle() {
      if (!active) return;
      if (operation.current || busy || confirm) { timer = setTimeout(cycle, 30000); return; }
      operation.current = true; setAutomaticBusy(true);
      let delay = 30000;
      try {
        if (pendingLanguageSave.current) {
          try { await api.saveSettings({ ...settings, language: preferredLanguage.current }); pendingLanguageSave.current = false; setPreferenceError(''); }
          catch (error) { setPreferenceError(messageFromError(error)); }
        }
        const writesAllowed = !failedAutomatic.current;
        const result = await synchronize(settings, { refresh: api.refreshSelected, integration: api.integration, diagnose: api.diagnoseRouting, apply: api.applyRules, save: value => api.saveSettings({ ...value, language: preferredLanguage.current }) }, {
          allowWrites: writesAllowed, forceSave: writesAllowed && pendingSettingsSave.current,
          onIntegration: integration => { if (active) { setConnection(integration); setConnectionChecking(false); setConnectionError(''); } },
        });
        if (!active) return;
        readFailures.current = 0;
        if (writesAllowed) pendingSettingsSave.current = false;
        setAutomaticError(''); setDiagnosticError(result.diagnosticError);
        if (writesAllowed) setSettings(old => { const next = { ...result.settings, language: preferredLanguage.current }; return JSON.stringify(old) === JSON.stringify(next) ? old : next; });
        setConnection(result.integration); setDiagnostics(result.diagnostics);
        if (result.message) setResult(result.message);
      } catch (e) { if (active) {
        setDiagnostics(undefined);
        if (e instanceof SynchronizationFailure && e.integration) { setConnection(e.integration); setConnectionChecking(false); setConnectionError(''); }
        if (e instanceof SynchronizationFailure && !e.pausesWrites) {
          delay = readRetryDelay(++readFailures.current); setAutomaticError(messageFromError(e));
        } else {
          failedAutomatic.current = fingerprint; setWriteError(messageFromError(e));
          if (e instanceof SynchronizationFailure && e.phase === 'save' && e.settings) { pendingSettingsSave.current = true; setSettings({ ...e.settings, language: preferredLanguage.current }); setResult(m(e.ruleWriteCompleted ? 'result.completedSaveFailed' : 'result.saveFailed')); }
        }
      } }
      finally { operation.current = false; if (active) { setAutomaticBusy(false); timer = setTimeout(cycle, delay); } }
    }
    timer = setTimeout(cycle, 700);
    return () => { active = false; clearTimeout(timer); setAutomaticBusy(false); };
  }, [ready, settings, busy, confirm]);
  useEffect(() => {
    const language = normalizeLanguage(settings.language);
    void i18n.changeLanguage(language);
    document.documentElement.lang = language;
    const title = display(m('app.title'));
    document.title = title;
    if (api.desktop) void getCurrentWindow().setTitle(title).catch(() => {});
  }, [settings.language]);
  async function changeLanguage(language: UiLanguage) {
    if (!ready || operation.current) return;
    operation.current = true;
    preferredLanguage.current = language;
    const next = { ...settings, language };
    setSettings(next);
    setBusy(m('language.saving'));
    try { await api.saveSettings(next); pendingLanguageSave.current = false; setPreferenceError(''); }
    catch (error) { pendingLanguageSave.current = true; setPreferenceError(messageFromError(error)); }
    finally { operation.current = false; setBusy(''); }
  }
  const languageSelector = <TextField select size="small" label={t('language.label')} value={normalizeLanguage(settings.language)} disabled={blocked || !ready} onChange={event => void changeLanguage(event.target.value as UiLanguage)} sx={{ minWidth: 130 }} slotProps={{ select: { SelectDisplayProps: { 'aria-label': t('language.label') } } }}><MenuItem value="zh-CN">中文</MenuItem><MenuItem value="en">English</MenuItem></TextField>;
  async function persist(next: Settings): Promise<boolean> { if (operation.current) return false; operation.current = true; next = resumeAfterRoutingChange(settings, next); setBusy(m('busy.saving')); setError(''); try {
    await api.saveSettings({ ...next, language: preferredLanguage.current }); setSettings({ ...next, language: preferredLanguage.current });
    pendingSettingsSave.current = false;
    if (routingFingerprint(next) !== routingFingerprint(settings)) setDiagnostics(undefined);
    if (routingFingerprint(next) !== routingFingerprint(settings)) { failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); readFailures.current = 0; setResult(m('result.saved')); }
    return true;
  } catch (e) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setSettings({ ...next, language: preferredLanguage.current }); setWriteError(m('error.save', { error: messageFromError(e) })); return false; } finally { operation.current = false; setBusy(''); } }
  async function refresh() {
    if (!ready) { await initialize(); return; }
    if (operation.current) return;
    operation.current = true; setDiagnostics(undefined);
    setBusy(m('busy.scanning')); setError('');
    try {
      const workspace = await readWorkspace(() => Promise.resolve(settings), api.scanApps, stored => api.integration(stored.configDir));
      const errors: DisplayMessage[] = [];
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(m('error.scan', { error: messageFromError(workspace.apps.reason) }));
      let next = settings;
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
        setConnectionError('');
      } else setConnectionError(m('error.detect', { error: messageFromError(workspace.integration.reason) }));
      try { next = { ...next, selected: await api.refreshSelected(next.selected) }; }
      catch (e) { errors.push(m('error.refreshSelected', { error: messageFromError(e) })); }
      await api.saveSettings({ ...next, language: preferredLanguage.current }); setSettings({ ...next, language: preferredLanguage.current });
      setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0;
      setResult(m(routingFingerprint(next) !== routingFingerprint(settings) ? (next.applied?.hasRules === false ? 'result.helpersPaused' : 'result.helpersUpdated') : 'result.refreshed'));
      if (errors.length) setError(m('error.multiple', { errors })); else setToast(m('toast.scanned'));
    } catch (e) { failedAutomatic.current = routingFingerprint(settings); pendingSettingsSave.current = true; setWriteError(m('error.save', { error: messageFromError(e) })); } finally { operation.current = false; setBusy(''); }
  }
  async function checkConnections() {
    if (operation.current) return;
    operation.current = true;
    setBusy(m('busy.checking')); setDiagnosticError(''); setDiagnostics(undefined);
    try { setDiagnostics(await api.diagnoseRouting(settings.configDir)); }
    catch (e) { setDiagnosticError(messageFromError(e)); }
    finally { operation.current = false; setBusy(''); }
  }
  async function includeCandidate(app: AppEntry, path: string) {
    const current = selected.get(app.id);
    if (!current) return;
    await persist({ ...settings, selected: settings.selected.map(a => a.id === app.id ? { ...a, processes: [...new Set([...a.processes, path])], suggestedProcesses: (a.suggestedProcesses || []).filter(p => p !== path) } : a) });
  }
  async function addWebsite(domain: string): Promise<boolean> {
    if (operation.current || !ready) return false;
    if (websites.includes(domain.toLowerCase())) { setToast(m('toast.duplicate')); return false; }
    if (websites.length >= 200) { setToast(m('toast.limit')); return false; }
    return persist({ ...settings, websites: websiteDomains([...websites, domain]) });
  }
  async function removeWebsite(domain: string) {
    if (operation.current || !ready) return;
    await persist({ ...settings, websites: websites.filter(value => value !== domain) });
  }
  async function add() { if (operation.current) return; if (!api.desktop) { setToast(m('toast.desktopAdd')); return; }
    operation.current = true; setBusy(m('busy.choosingApp'));
    try { const path = await open({ multiple: false, filters: [{ name: t('dialog.windowsApps'), extensions: ['exe'] }] }); if (typeof path !== 'string') return;
      setBusy(m('busy.identifying')); const entry = await api.inspectApp(path); setApps(old => [...old.filter(a => a.id !== entry.id), entry]); setToast(m('toast.added'));
    } catch (e) { setError(messageFromError(e)); } finally { operation.current = false; setBusy(''); } }
  async function chooseDir() { if (operation.current) return; operation.current = true; setBusy(m('busy.choosingDir')); try { const dir = await open({ directory: true, multiple: false }); if (typeof dir === 'string') setDraftDir(dir); } catch(e) { setError(messageFromError(e)); } finally { operation.current = false; setBusy(''); } }
  async function saveDir() {
    if (operation.current) return;
    operation.current = true; setDiagnostics(undefined); setBusy(m('busy.detecting')); setError('');
    let next: Settings | undefined;
    try {
      const status = await api.integration(draftDir);
      if (!status.found) throw status.message;
      next = settingsAfterConnection(settings, status, draftDir, connection);
      await api.saveSettings({ ...next, language: preferredLanguage.current }); setSettings({ ...next, language: preferredLanguage.current }); setDraftDir(next.configDir); setConnection(status); setConnectionChecking(false); setConnectionError(''); setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0; setToast(m('toast.connected'));
    } catch(e) {
      if (next) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setSettings({ ...next, language: preferredLanguage.current }); setWriteError(m('error.saveDir', { error: messageFromError(e) })); }
      else setError(messageFromError(e));
    } finally { operation.current = false; setBusy(''); }
  }
  async function execute() { if (operation.current || !confirm) return; operation.current = true; const action = confirm; setConfirm(null); setBusy(m(action === 'apply' ? 'busy.applying' : 'busy.removing')); setError(''); try {
    setDiagnostics(undefined);
    // Refresh every chosen app on disk so helpers can be discovered even when not running.
    let chosen = settings.selected;
    if (action === 'apply' && api.desktop) {
      chosen = await api.refreshSelected(settings.selected);
      const refreshed = { ...settings, selected: chosen };
      await api.saveSettings({ ...refreshed, language: preferredLanguage.current }); setSettings(refreshed);
      const missing = chosen.filter(app => app.pathMissing);
      if (missing.length) throw m('error.missingPaths', { names: missing.map(app => app.name).join(', ') });
    }
    const res = action === 'apply' ? await api.applyRules(chosen, settings.configDir, settings.otherTraffic, settings.proxyGroup, websites) : await api.removeRules(settings.configDir);
    const next: Settings = { ...settings, selected: chosen };
    next.applied = { revision: ROUTING_REVISION, fingerprint: routingFingerprint(next), pendingRestart: res.pendingRestart ?? api.desktop, hasRules: action === 'apply' && (chosen.length > 0 || websites.length > 0 || settings.otherTraffic === 'proxy') };
    setSettings({ ...next, language: preferredLanguage.current }); setResult(res.message); setToast(res.message); failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0;
    // A settings/detection failure after writing must not masquerade as a failed rule write.
    const followup = await Promise.allSettled([api.saveSettings({ ...next, language: preferredLanguage.current }), api.integration(settings.configDir)]);
    if (followup[0].status === 'rejected') { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setWriteError(m('error.followupSave')); }
    if (followup[1].status === 'fulfilled') { setConnection(followup[1].value); setConnectionError(''); }
    else setConnectionError(m('error.followupDetection'));
  } catch(e) { failedAutomatic.current = routingFingerprint(settings); setWriteError(messageFromError(e)); } finally { operation.current = false; setBusy(''); } }
  const routingControls = <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label={t('routing.other')} size="small" sx={{ flex: 1 }} value={settings.otherTraffic} disabled={blocked || !ready} onChange={e => persist({ ...settings, otherTraffic: e.target.value as Settings['otherTraffic'] })}>
              <MenuItem value="proxy">{t('routing.proxy')}</MenuItem><MenuItem value="subscription">{t('routing.subscription')}</MenuItem>
            </TextField>
            {settings.otherTraffic === 'proxy' && <TextField select label={t('routing.group')} size="small" sx={{ flex: 1 }} value={settings.proxyGroup} disabled={blocked || !ready} onChange={e => persist({ ...settings, proxyGroup: e.target.value })}>
              {[...new Set(['GLOBAL', ...(connection?.proxyGroups || []), settings.proxyGroup])].map(group => <MenuItem key={group} value={group}>{group === 'GLOBAL' ? t('routing.global') : group}</MenuItem>)}
            </TextField>}
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>{settings.otherTraffic === 'proxy' ? t('routing.proxyHelp') : t('routing.subscriptionHelp')}</Typography>
        </Paper>;
  const routingActions = <><Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={2} mt={3}><Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{display(result) || t('routing.autoHelp')}</Typography><Stack direction="row" spacing={1}><Button startIcon={<Undo/>} disabled={blocked || !ready || (api.desktop && !connection?.managed)} onClick={() => { if (!operation.current) setConfirm('remove'); }}>{t('action.undo')}</Button><Button variant="contained" disabled={blocked || !ready || (api.desktop && !connection?.found)} onClick={() => { if (!operation.current) setConfirm('apply'); }}>{t('action.apply')}</Button></Stack></Stack>
        <Alert severity={reconnecting || connection?.found ? 'info' : 'warning'} sx={{ mt: 3 }}>{reconnecting ? t('connection.reconnecting') : display(connection?.message) || t('connection.retrying')}{api.desktop && ready && !reconnecting && !connection?.found && <Button size="small" onClick={() => setPage('settings')}>{t('connection.connect')}</Button>}</Alert></>;
  return <ThemeProvider theme={theme}><CssBaseline/><Box sx={{ display: 'flex', minHeight: '100vh' }}>
    <Paper square sx={{ width: 205, flexShrink: 0, borderRight: 1, borderColor: 'divider', bgcolor: settings.dark ? '#1e202a' : '#eef0f7', p: 2.5, display: { xs: 'none', md: 'flex' }, flexDirection: 'column' }}>
      <Stack direction="row" spacing={1.2} alignItems="center" sx={{ mb: 5 }}><Box component="img" src="/app-icon.png" alt={t('app.icon')} sx={{ width: 36, height: 36, objectFit: 'contain' }}/><Typography fontWeight={700} fontSize={19}>{t('app.name')}</Typography></Stack>
      <List disablePadding>{[['apps', t('nav.apps')], ['websites', t('nav.websites')], ['settings', t('nav.settings')]].map(([id, label]) => <ListItemButton key={id} selected={page === id} onClick={() => setPage(id)} sx={{ borderRadius: 2, mb: 1 }}><ListItemIcon sx={{ minWidth: 34 }}>{id === 'apps' ? <Apps/> : id === 'websites' ? <Language/> : <SettingsIcon/>}</ListItemIcon><ListItemText primary={label}/></ListItemButton>)}</List>
      <Box sx={{ mt: 'auto', pt: 4 }}><Typography variant="caption" color="text.secondary">Clash App Bypass · v{version}<br/>{t('app.credit')}</Typography></Box>
    </Paper>
    <Box component="main" sx={{ flex: 1, minWidth: 0, p: { xs: 2, md: 4 }, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2} justifyContent="space-between" alignItems={{ xs: 'stretch', sm: 'center' }} mb={3}><Typography variant="h4">{page === 'apps' ? t('heading.apps') : page === 'websites' ? t('nav.websites') : t('nav.settings')}</Typography><Stack direction="row" flexWrap="wrap" useFlexGap alignItems="center" spacing={1}>{languageSelector}<Chip size="small" variant="outlined" color={api.desktop ? 'primary' : 'warning'} label={api.desktop ? t('mode.desktop') : t('mode.demo')}/><Tooltip title={t('theme.switch')}><IconButton disabled={blocked || !ready} onClick={() => persist({ ...settings, dark: !settings.dark })}>{settings.dark ? <LightMode/> : <DarkMode/>}</IconButton></Tooltip><IconButton sx={{ display: { md: 'none' } }} onClick={() => setPage(page === 'settings' ? 'apps' : 'settings')} aria-label={t('settings.switch')}><SettingsIcon/></IconButton></Stack></Stack>
      <Tabs value={page} onChange={(_, value) => setPage(value)} sx={{ display: { md: 'none' }, mb: 2 }}><Tab value="apps" label={t('nav.apps')}/><Tab value="websites" label={t('nav.websites')}/><Tab value="settings" label={t('nav.settings')}/></Tabs>
      {preferenceError && <Alert severity="warning" sx={{ mb: 2 }} action={<Button disabled={blocked} onClick={() => void changeLanguage(preferredLanguage.current)}>{t('language.retry')}</Button>}>{t('language.failed', { error: display(preferenceError) })}</Alert>}
      {error && <Alert severity="error" onClose={() => setError('')} action={<Button color="inherit" size="small" disabled={blocked} onClick={refresh}>{t('action.retry')}</Button>} sx={{ mb: 2, overflowWrap: 'anywhere' }}>{display(error)}</Alert>}
      {!api.desktop && <Alert severity="info" sx={{ mb: 2 }}>{t('demo.help')}</Alert>}
      {automaticBusy && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>{t('busy.syncing')}</Typography>}
      {connectionError && <Alert severity="info" sx={{ mb: 2 }}>{t('connection.errorHelp', { error: display(connectionError) })}</Alert>}
      {automaticError && <Alert severity="info" sx={{ mb: 2 }} action={<Button disabled={blocked} onClick={() => { if (operation.current) return; readFailures.current = 0; setAutomaticError(''); setSettings(old => ({ ...old })); }}>{t('action.retryChecks')}</Button>}>{t('automatic.readError', { error: display(automaticError) })}</Alert>}
      {writeError && <Alert severity="warning" sx={{ mb: 2 }} action={<Button disabled={blocked} onClick={() => { if (operation.current) return; failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); readFailures.current = 0; setSettings(old => ({ ...old })); }}>{t('action.retryAutomatic')}</Button>}>{t('automatic.writeError', { error: display(writeError) })}</Alert>}
      {busy && <Stack direction="row" spacing={1} alignItems="center" mb={2} role="status"><CircularProgress size={17}/><Typography variant="body2">{display(busy)}</Typography></Stack>}
      {page !== 'settings' && <Alert severity={status.label === 'status.written.label' ? 'success' : 'info'} sx={{ mb: 2 }}><Stack direction="row" spacing={1} alignItems="center"><Chip size="small" label={display({ key: status.label })}/><Typography variant="body2">{display(status.message)}</Typography>{settings.applied?.pendingRestart && <Button size="small" disabled={blocked} onClick={refresh}>{t('action.checkRestart')}</Button>}</Stack></Alert>}
      {page === 'apps' ? <>
        <Typography color="text.secondary" mb={3}>{t('apps.help')}</Typography>
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}><Typography fontWeight={600}>{t('diagnostics.title')}</Typography><Button disabled={!api.desktop || blocked || !ready || !settings.selected.length} onClick={checkConnections}>{t('diagnostics.check')}</Button></Stack>
          <Typography variant="body2" color="text.secondary">{t('diagnostics.help')}</Typography>
          {diagnosticError && <Alert severity="warning" sx={{ mt: 1 }}>{t('diagnostics.error', { error: display(diagnosticError) })}</Alert>}
          {diagnostics && <>
            <Typography variant="caption" color="text.secondary">{t('diagnostics.time', { time: new Date(diagnostics.checkedAt).toLocaleTimeString(settings.language), mode: diagnostics.mode, processMode: diagnostics.findProcessMode || t('diagnostics.unknown') })}</Typography>
            {settings.selected.map(a => { const evidence = diagnoseApp(a, diagnostics); return <Alert key={a.id} severity={evidence.severity} sx={{ mt: 1 }}><Typography variant="body2">{t('diagnostics.evidence', { name: a.name, label: display({ key: evidence.label }), direct: evidence.direct, proxied: evidence.proxied, blocked: evidence.blocked })}</Typography>{evidence.missingPaths.length > 0 && <Typography variant="caption">{t('diagnostics.missing', { count: evidence.missingPaths.length })}</Typography>}{evidence.uncovered.length > 0 && <Typography variant="caption" display="block">{t('diagnostics.uncovered', { count: evidence.uncovered.length })}</Typography>}</Alert>; })}
            {diagnostics.unidentifiedConnections > 0 && <Alert severity="warning" sx={{ mt: 1 }}>{t('diagnostics.unidentified', { count: diagnostics.unidentifiedConnections })}</Alert>}
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{t('diagnostics.snapshot')}</Typography>
          </>}
        </Paper>
        {routingControls}
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}><Stack direction="row" divider={<Divider orientation="vertical" flexItem/>} spacing={3}>{[[t('stats.detected'), combined.length], [t('stats.selected'), settings.selected.length], [t('stats.processes'), count]].map(([label, n]) => <Box key={label} sx={{ flex: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontSize={26} fontWeight={600}>{n}</Typography></Box>)}</Stack></Paper>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} mb={2}><TextField size="small" placeholder={t('apps.search')} value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: 1 }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small"/></InputAdornment> }, htmlInput: { 'aria-label': t('apps.search') } }}/><Button variant="outlined" startIcon={<Refresh/>} disabled={blocked} onClick={refresh}>{ready ? t('apps.rescan') : t('apps.retryInit')}</Button><Button variant="outlined" startIcon={<Add/>} disabled={blocked || !ready} onClick={add}>{t('apps.add')}</Button></Stack>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}><Tab label={t('apps.all')}/><Tab label={t('apps.running')}/><Tab label={t('apps.selected')}/></Tabs>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          {!filtered.length && <Box sx={{ p: 5, textAlign: 'center' }}><Typography color="text.secondary">{busy ? t('busy.loading') : t('apps.empty')}</Typography>{!busy && <Button disabled={blocked || !ready} onClick={add} sx={{ mt: 1 }}>{t('apps.addFile')}</Button>}</Box>}
          {filtered.map((a, i) => <Box key={a.id}><Stack direction="row" spacing={2} alignItems="center" sx={{ p: 2 }}><Avatar variant="rounded" sx={{ bgcolor: selected.has(a.id) ? 'primary.main' : 'action.disabledBackground', color: selected.has(a.id) ? 'primary.contrastText' : 'text.secondary' }}>{a.name.slice(0, 1)}</Avatar><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600}>{a.name}</Typography><Typography variant="caption" color="text.secondary">{a.pathMissing ? t('apps.missing') : a.running ? t('apps.running') : t('apps.notRunning')} · {display(a.sourceMessage ?? a.source)}</Typography><Tooltip title={a.path}><Typography variant="caption" display="block" color="text.secondary" noWrap>{a.path}</Typography></Tooltip><Button size="small" sx={{ p: 0, mt: .5, fontSize: 12 }} endIcon={expanded.includes(a.id) ? <ExpandMore/> : <ChevronRight/>} aria-expanded={expanded.includes(a.id)} onClick={() => setExpanded(old => old.includes(a.id) ? old.filter(id => id !== a.id) : [...old, a.id])}>{t('apps.processCount', { count: a.processes.length })}</Button></Box><Stack alignItems="center"><Switch checked={selected.has(a.id)} disabled={blocked || !ready} slotProps={{ input: { 'aria-label': t('apps.bypassAria', { name: a.name }) } }} onChange={(_, checked) => persist({ ...settings, selected: checked ? [...settings.selected, a] : settings.selected.filter(b => b.id !== a.id) })}/><Typography variant="caption" color="text.secondary">{selected.has(a.id) ? t('apps.direct') : settings.otherTraffic === 'proxy' ? t('apps.proxied') : t('apps.subscription')}</Typography></Stack></Stack><Collapse in={expanded.includes(a.id)}><Box sx={{ px: 3, pb: 2 }}>{(a.warningMessages ?? a.warnings).map((w, index) => <Alert key={index} severity="warning" sx={{ mb: 1 }}>{display(w)}</Alert>)}{(a.suggestedProcesses || []).filter(p => !a.processes.some(known => known.toLowerCase() === p.toLowerCase())).map(p => <Paper key={p} variant="outlined" sx={{ p: 1.5, mb: 1 }}><Typography variant="body2">{t('apps.candidate')}</Typography><Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{p}</Typography><Button size="small" disabled={blocked || !selected.has(a.id)} onClick={() => includeCandidate(a, p)}>{t('apps.confirmCandidate')}</Button><Typography variant="caption" display="block">{t('apps.candidateHelp')}</Typography></Paper>)}<Typography variant="caption" color="text.secondary">{t('apps.pathHelp')}</Typography>{a.processes.map(p => <Typography key={p} sx={{ fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere', mt: .5 }}>{p}</Typography>)}</Box></Collapse>{i < filtered.length - 1 && <Divider/>}</Box>)}
        </Paper>
        {routingActions}
      </> : page === 'websites' ? <>
        {diagnosticError && <Alert severity="warning" sx={{ mb: 2 }}>{t('diagnostics.websiteError', { error: display(diagnosticError) })}</Alert>}
        <WebsitePanel websites={websites} disabled={blocked || !ready} diagnostics={diagnostics} onAdd={addWebsite} onRemove={removeWebsite} onCheck={checkConnections}/>
        {routingControls}
        {routingActions}
      </> : <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h6" mb={2}>{t('language.label')}</Typography>{languageSelector}<Typography variant="body2" color="text.secondary" mt={1}>{t('language.help')}</Typography><Divider sx={{ my: 3 }}/><Typography variant="h6" mb={1}>{t('settings.dirHeading')}</Typography><Typography color="text.secondary" variant="body2" mb={2}>{t('settings.dirHelp')}</Typography><Stack direction="row" spacing={1}><TextField size="small" fullWidth disabled={blocked} value={draftDir} onChange={e => setDraftDir(e.target.value)} placeholder={t('settings.dirPlaceholder')} slotProps={{ htmlInput: { 'aria-label': t('settings.dirAria') } }}/><Button variant="outlined" disabled={!api.desktop || blocked} onClick={chooseDir} aria-label={t('settings.browse')}><FolderOpen/></Button></Stack>{connection?.found && <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>{t('settings.currentDir', { directory: connection.configDir, automatic: !settings.configDir ? t('settings.autoDir') : '' })}</Typography>}<Button variant="contained" sx={{ mt: 2 }} disabled={!api.desktop || blocked || !ready} onClick={saveDir}>{t('settings.detectSave')}</Button><Divider sx={{ my: 3 }}/><Typography variant="h6" mb={1}>{t('settings.instructions')}</Typography><Typography variant="body2" color="text.secondary" sx={{ lineHeight: 2 }}>{t('settings.step1')}<br/>{t('settings.step2')}<br/>{t('settings.step3')}<br/>{t('settings.step4')}<br/>{t('settings.step5')}</Typography><Alert severity="info" sx={{ mt: 2 }}>{t('settings.limitations')}</Alert><Typography variant="caption" display="block" mt={2} color="text.secondary">{t('settings.disclaimer')}</Typography></Paper>}
    </Box>
    <Dialog open={confirm !== null} onClose={() => !blocked && setConfirm(null)} maxWidth="sm" fullWidth><DialogTitle>{confirm === 'apply' ? t('dialog.apply') : t('action.undo')}</DialogTitle><DialogContent><Typography>{api.desktop ? t('dialog.desktopHelp') : t('dialog.demoHelp')}</Typography><Alert severity="info" sx={{ mt: 2 }}>{confirm === 'apply' ? t('dialog.summary', { apps: settings.selected.length, processes: count, websites: websites.length, routing: settings.otherTraffic === 'proxy' ? t('dialog.proxyGroup', { group: settings.proxyGroup }) : t('routing.subscription') }) : t('dialog.undoHelp')}</Alert></DialogContent><DialogActions><Button disabled={blocked} onClick={() => setConfirm(null)}>{t('action.cancel')}</Button><Button disabled={blocked} variant="contained" onClick={execute}>{api.desktop ? t('action.continue') : t('action.simulate')}</Button></DialogActions></Dialog>
    <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast('')} message={display(toast)}/>
  </Box></ThemeProvider>;
}
