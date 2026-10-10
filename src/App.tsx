import { useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Collapse, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Paper, Snackbar, Stack, Switch, Tab, Tabs, TextField, ThemeProvider, Tooltip, Typography } from '@mui/material';
import { Apps, Add, ChevronRight, DarkMode, FolderOpen, LightMode, Refresh, Search, Settings as SettingsIcon, Undo, ExpandMore } from '@mui/icons-material';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from './api';
import type { AppEntry, Integration, Settings } from './types';
import { makeTheme } from './theme';
import { readRetryDelay, synchronize, SynchronizationFailure, ROUTING_REVISION } from './automation';
import { applicationStatus, readWorkspace, resumeAfterRoutingChange, routingFingerprint, settingsAfterConnection } from './workflow';
import { diagnoseApp } from './routingDiagnostics';
import type { RoutingSnapshot } from './routingDiagnostics';

export default function App() {
  const operation = useRef(false);
  const failedAutomatic = useRef('');
  const readFailures = useRef(0);
  const pendingSettingsSave = useRef(false);
  const [automaticError, setAutomaticError] = useState('');
  const [writeError, setWriteError] = useState('');
  const [automaticBusy, setAutomaticBusy] = useState(false);
  const [settings, setSettings] = useState<Settings>({ selected: [], configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' });
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [connection, setConnection] = useState<Integration>();
  const [connectionChecking, setConnectionChecking] = useState(api.desktop);
  const [connectionError, setConnectionError] = useState('');
  const [busy, setBusy] = useState('正在读取软件清单…');
  const [error, setError] = useState('');
  const [toast, setToast] = useState('');
  const [query, setQuery] = useState('');
  const [tab, setTab] = useState(0);
  const [page, setPage] = useState('apps');
  const [expanded, setExpanded] = useState<string[]>([]);
  const [confirm, setConfirm] = useState<'apply' | 'remove' | null>(null);
  const [result, setResult] = useState('');
  const [ready, setReady] = useState(false);
  const [diagnostics, setDiagnostics] = useState<RoutingSnapshot>();
  const [diagnosticError, setDiagnosticError] = useState('');
  const [draftDir, setDraftDir] = useState('');
  const theme = useMemo(() => makeTheme(settings.dark), [settings.dark]);
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
    return [...byId.values()].sort((a, b) => Number(selected.has(b.id)) - Number(selected.has(a.id)) || a.name.localeCompare(b.name, 'zh-CN'));
  }, [apps, settings.selected, selected]);
  const filtered = combined.filter(a => (tab !== 1 || a.running) && (tab !== 2 || selected.has(a.id)) && `${a.name} ${a.path} ${a.processes.join(' ')}`.toLowerCase().includes(query.toLowerCase()));
  const count = new Set(settings.selected.flatMap(a => a.processes)).size;
  async function initialize(isActive = () => true) {
    setBusy('正在读取软件清单…'); setError(''); setConnectionChecking(api.desktop); setConnectionError('');
    try {
      const stored = await api.loadSettings();
      if (!isActive()) return;
      setSettings(stored); setDraftDir(stored.configDir);
      const workspace = await readWorkspace(() => Promise.resolve(stored), api.scanApps, stored => api.integration(stored.configDir), detected => {
        if (!isActive()) return;
        setConnectionChecking(false);
        if (detected.status === 'fulfilled') { setConnection(detected.value); setConnectionError(''); }
        else setConnectionError(`Clash 检测暂时失败：${String(detected.reason)}`);
      });
      if (!isActive()) return;
      let next = workspace.settings;
      const errors: string[] = [];
      try { next = { ...next, selected: await api.refreshSelected(next.selected) }; }
      catch (e) { setAutomaticError(`所选软件刷新暂时失败：${String(e)}`); }
      if (!isActive()) return;
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(`软件扫描失败：${String(workspace.apps.reason)}`);
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
      }
      setSettings(next); setDraftDir(next.configDir); setReady(true);
      if (errors.length) setError(errors.join('；'));
      if (JSON.stringify(next) !== JSON.stringify(workspace.settings)) {
        try { await api.saveSettings(next); }
        catch (e) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setWriteError(`选择状态保存失败：${String(e)}`); }
      }
    } catch (e) { if (isActive()) setError(String(e)); }
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
        const writesAllowed = !failedAutomatic.current;
        const result = await synchronize(settings, { refresh: api.refreshSelected, integration: api.integration, diagnose: api.diagnoseRouting, apply: api.applyRules, save: api.saveSettings }, {
          allowWrites: writesAllowed, forceSave: writesAllowed && pendingSettingsSave.current,
          onIntegration: integration => { if (active) { setConnection(integration); setConnectionChecking(false); setConnectionError(''); } },
        });
        if (!active) return;
        readFailures.current = 0;
        if (writesAllowed) pendingSettingsSave.current = false;
        setAutomaticError(''); setDiagnosticError(result.diagnosticError);
        if (writesAllowed) setSettings(old => JSON.stringify(old) === JSON.stringify(result.settings) ? old : result.settings);
        setConnection(result.integration); setDiagnostics(result.diagnostics);
        if (result.message) setResult(result.message);
      } catch (e) { if (active) {
        setDiagnostics(undefined);
        if (e instanceof SynchronizationFailure && e.integration) { setConnection(e.integration); setConnectionChecking(false); setConnectionError(''); }
        if (e instanceof SynchronizationFailure && !e.pausesWrites) {
          delay = readRetryDelay(++readFailures.current); setAutomaticError(e.message);
        } else {
          failedAutomatic.current = fingerprint; setWriteError(e instanceof Error ? e.message : String(e));
          if (e instanceof SynchronizationFailure && e.phase === 'save' && e.settings) { pendingSettingsSave.current = true; setSettings(e.settings); setResult(`${e.ruleWriteCompleted ? '规则操作已完成，但' : ''}状态保存失败；自动写入已暂停。`); }
        }
      } }
      finally { operation.current = false; if (active) { setAutomaticBusy(false); timer = setTimeout(cycle, delay); } }
    }
    timer = setTimeout(cycle, 700);
    return () => { active = false; clearTimeout(timer); setAutomaticBusy(false); };
  }, [ready, settings, busy, confirm]);
  async function persist(next: Settings) { if (operation.current) return; operation.current = true; next = resumeAfterRoutingChange(settings, next); setBusy('正在保存选择…'); setError(''); try {
    await api.saveSettings(next); setSettings(next);
    pendingSettingsSave.current = false;
    if (routingFingerprint(next) !== routingFingerprint(settings)) setDiagnostics(undefined);
    if (routingFingerprint(next) !== routingFingerprint(settings)) { failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); readFailures.current = 0; setResult('选择已保存，正在自动应用…'); }
  } catch (e) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setSettings(next); setWriteError(`选择状态保存失败：${String(e)}`); } finally { operation.current = false; setBusy(''); } }
  async function refresh() {
    if (!ready) { await initialize(); return; }
    if (operation.current) return;
    operation.current = true; setDiagnostics(undefined);
    setBusy('正在扫描应用和相关进程…'); setError('');
    try {
      const workspace = await readWorkspace(() => Promise.resolve(settings), api.scanApps, stored => api.integration(stored.configDir));
      const errors: string[] = [];
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(`软件扫描失败：${String(workspace.apps.reason)}`);
      let next = settings;
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
        setConnectionError('');
      } else setConnectionError(`Clash 检测暂时失败：${String(workspace.integration.reason)}`);
      try { next = { ...next, selected: await api.refreshSelected(next.selected) }; }
      catch (e) { errors.push(`所选软件刷新失败：${String(e)}`); }
      await api.saveSettings(next); setSettings(next);
      setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0;
      setResult(routingFingerprint(next) !== routingFingerprint(settings) ? (next.applied?.hasRules === false ? '已更新关联程序，自动应用保持暂停' : '已更新关联程序，正在自动应用…') : '已刷新软件清单与 Clash 状态');
      if (errors.length) setError(errors.join('；')); else setToast('扫描完成，已检查所选软件及辅助程序路径');
    } catch (e) { failedAutomatic.current = routingFingerprint(settings); pendingSettingsSave.current = true; setWriteError(`选择状态保存失败：${String(e)}`); } finally { operation.current = false; setBusy(''); }
  }
  async function checkConnections() {
    if (operation.current) return;
    operation.current = true;
    setBusy('正在检查实际连接…'); setDiagnosticError(''); setDiagnostics(undefined);
    try { setDiagnostics(await api.diagnoseRouting(settings.configDir)); }
    catch (e) { setDiagnosticError(String(e)); }
    finally { operation.current = false; setBusy(''); }
  }
  async function includeCandidate(app: AppEntry, path: string) {
    const current = selected.get(app.id);
    if (!current) return;
    await persist({ ...settings, selected: settings.selected.map(a => a.id === app.id ? { ...a, processes: [...new Set([...a.processes, path])], suggestedProcesses: (a.suggestedProcesses || []).filter(p => p !== path) } : a) });
  }
  async function add() { if (operation.current) return; if (!api.desktop) { setToast('桌面版可选择 .exe 文件，浏览器版仅展示示例应用'); return; }
    operation.current = true; setBusy('正在选择软件…');
    try { const path = await open({ multiple: false, filters: [{ name: 'Windows 应用', extensions: ['exe'] }] }); if (typeof path !== 'string') return;
      setBusy('正在识别软件…'); const entry = await api.inspectApp(path); setApps(old => [...old.filter(a => a.id !== entry.id), entry]); setToast('已添加软件，打开“不使用代理”开关即可选择');
    } catch (e) { setError(String(e)); } finally { operation.current = false; setBusy(''); } }
  async function chooseDir() { if (operation.current) return; operation.current = true; setBusy('正在选择配置目录…'); try { const dir = await open({ directory: true, multiple: false }); if (typeof dir === 'string') setDraftDir(dir); } catch(e) { setError(String(e)); } finally { operation.current = false; setBusy(''); } }
  async function saveDir() {
    if (operation.current) return;
    operation.current = true; setDiagnostics(undefined); setBusy('正在检测 Clash…'); setError('');
    let next: Settings | undefined;
    try {
      const status = await api.integration(draftDir);
      if (!status.found) throw new Error(status.message);
      next = settingsAfterConnection(settings, status, draftDir, connection);
      await api.saveSettings(next); setSettings(next); setDraftDir(next.configDir); setConnection(status); setConnectionChecking(false); setConnectionError(''); setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0; setToast('Clash 配置目录已连接');
    } catch(e) {
      if (next) { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setSettings(next); setWriteError(`配置目录保存失败：${String(e)}`); }
      else setError(String(e));
    } finally { operation.current = false; setBusy(''); }
  }
  async function execute() { if (operation.current || !confirm) return; operation.current = true; const action = confirm; setConfirm(null); setBusy(action === 'apply' ? '正在写入本工具规则…' : '正在撤销本工具规则…'); setError(''); try {
    setDiagnostics(undefined);
    // Refresh every chosen app on disk so helpers can be discovered even when not running.
    let chosen = settings.selected;
    if (action === 'apply' && api.desktop) {
      chosen = await api.refreshSelected(settings.selected);
      const refreshed = { ...settings, selected: chosen };
      await api.saveSettings(refreshed); setSettings(refreshed);
      const missing = chosen.filter(app => app.pathMissing);
      if (missing.length) throw new Error(`主程序路径已失效：${missing.map(app => app.name).join('、')}。请取消选择并重新添加。`);
    }
    const res = action === 'apply' ? await api.applyRules(chosen, settings.configDir, settings.otherTraffic, settings.proxyGroup) : await api.removeRules(settings.configDir);
    const next: Settings = { ...settings, selected: chosen };
    next.applied = { revision: ROUTING_REVISION, fingerprint: routingFingerprint(next), pendingRestart: res.pendingRestart ?? api.desktop, hasRules: action === 'apply' && (chosen.length > 0 || settings.otherTraffic === 'proxy') };
    setSettings(next); setResult(res.message); setToast(res.message); failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); pendingSettingsSave.current = false; readFailures.current = 0;
    // A settings/detection failure after writing must not masquerade as a failed rule write.
    const followup = await Promise.allSettled([api.saveSettings(next), api.integration(settings.configDir)]);
    if (followup[0].status === 'rejected') { failedAutomatic.current = routingFingerprint(next); pendingSettingsSave.current = true; setWriteError('规则操作已完成，但状态保存失败'); }
    if (followup[1].status === 'fulfilled') { setConnection(followup[1].value); setConnectionError(''); }
    else setConnectionError('规则操作已完成，但 Clash 状态检测暂时失败，正在自动重试');
  } catch(e) { failedAutomatic.current = routingFingerprint(settings); setWriteError(e instanceof Error ? e.message : String(e)); } finally { operation.current = false; setBusy(''); } }
  return <ThemeProvider theme={theme}><CssBaseline/><Box sx={{ display: 'flex', minHeight: '100vh' }}>
    <Paper square sx={{ width: 205, flexShrink: 0, borderRight: 1, borderColor: 'divider', bgcolor: settings.dark ? '#1e202a' : '#eef0f7', p: 2.5, display: { xs: 'none', md: 'flex' }, flexDirection: 'column' }}>
      <Stack direction="row" spacing={1.2} alignItems="center" sx={{ mb: 5 }}><Box component="img" src="/app-icon.png" alt="直连助手图标" sx={{ width: 36, height: 36, objectFit: 'contain' }}/><Typography fontWeight={700} fontSize={19}>直连助手</Typography></Stack>
      <List disablePadding>{[['apps', '应用分流'], ['settings', '设置']].map(([id, label]) => <ListItemButton key={id} selected={page === id} onClick={() => setPage(id)} sx={{ borderRadius: 2, mb: 1 }}><ListItemIcon sx={{ minWidth: 34 }}>{id === 'apps' ? <Apps/> : <SettingsIcon/>}</ListItemIcon><ListItemText primary={label}/></ListItemButton>)}</List>
      <Box sx={{ mt: 'auto', pt: 4 }}><Typography variant="caption" color="text.secondary">Clash App Bypass · v0.1.7<br/>Clash Verge Rev 第三方助手</Typography></Box>
    </Paper>
    <Box component="main" sx={{ flex: 1, minWidth: 0, p: { xs: 2, md: 4 }, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={3}><Typography variant="h4">{page === 'apps' ? '不使用代理的软件' : '设置'}</Typography><Stack direction="row" alignItems="center" spacing={1}><Chip size="small" variant="outlined" color={api.desktop ? 'primary' : 'warning'} label={api.desktop ? '桌面版' : '浏览器演示'}/><Tooltip title="切换主题"><IconButton disabled={blocked || !ready} onClick={() => persist({ ...settings, dark: !settings.dark })}>{settings.dark ? <LightMode/> : <DarkMode/>}</IconButton></Tooltip><IconButton sx={{ display: { md: 'none' } }} onClick={() => setPage(page === 'apps' ? 'settings' : 'apps')} aria-label="切换设置页面"><SettingsIcon/></IconButton></Stack></Stack>
      {error && <Alert severity="error" onClose={() => setError('')} action={<Button color="inherit" size="small" disabled={blocked} onClick={refresh}>重试</Button>} sx={{ mb: 2, overflowWrap: 'anywhere' }}>{error}</Alert>}
      {!api.desktop && <Alert severity="info" sx={{ mb: 2 }}>浏览器中展示示例数据。真实扫描与配置应用需要运行桌面版。</Alert>}
      {automaticBusy && <Typography variant="caption" color="text.secondary" display="block" sx={{ mb: 1 }}>正在自动检查和同步规则…</Typography>}
      {connectionError && <Alert severity="info" sx={{ mb: 2 }}>{connectionError}。会继续自动检测，无需重新选择已保存的目录。</Alert>}
      {automaticError && <Alert severity="info" sx={{ mb: 2 }} action={<Button disabled={blocked} onClick={() => { if (operation.current) return; readFailures.current = 0; setAutomaticError(''); setSettings(old => ({ ...old })); }}>立即重试检查</Button>}>{automaticError}。正在自动重试检查，选择已保留。</Alert>}
      {writeError && <Alert severity="warning" sx={{ mb: 2 }} action={<Button disabled={blocked} onClick={() => { if (operation.current) return; failedAutomatic.current = ''; setWriteError(''); setAutomaticError(''); readFailures.current = 0; setSettings(old => ({ ...old })); }}>重试自动处理</Button>}>{writeError}。自动写入已暂停，连接检查会继续；修改分流选择或重试后恢复。</Alert>}
      {busy && <Stack direction="row" spacing={1} alignItems="center" mb={2} role="status"><CircularProgress size={17}/><Typography variant="body2">{busy}</Typography></Stack>}
      {page === 'apps' ? <>
        <Alert severity={status.label === '规则已写入' ? 'success' : 'info'} sx={{ mb: 2 }}><Stack direction="row" spacing={1} alignItems="center"><Chip size="small" label={status.label}/><Typography variant="body2">{status.message}</Typography>{settings.applied?.pendingRestart && <Button size="small" disabled={blocked} onClick={refresh}>已重启，检查状态</Button>}</Stack></Alert>
        <Typography color="text.secondary" mb={3}>打开开关即可自动保存、应用和检查直连。助手关闭后停止检测，已保存的规则继续有效。</Typography>
        <Paper variant="outlined" sx={{ p: 2, mb: 3 }}>
          <Stack direction="row" justifyContent="space-between" alignItems="center" spacing={2}><Typography fontWeight={600}>实际连接检查</Typography><Button disabled={!api.desktop || blocked || !ready || !settings.selected.length} onClick={checkConnections}>检查实际连接</Button></Stack>
          <Typography variant="body2" color="text.secondary">助手打开时会自动检查，已确认的辅助程序会自动补齐并应用。需要时也可以立即检查连接。</Typography>
          {diagnosticError && <Alert severity="warning" sx={{ mt: 1 }}>{diagnosticError}。本次未验证直连。</Alert>}
          {diagnostics && <>
            <Typography variant="caption" color="text.secondary">检查时间：{new Date(diagnostics.checkedAt).toLocaleTimeString()} · Clash 模式：{diagnostics.mode} · 进程识别：{diagnostics.findProcessMode || '未知'}</Typography>
            {settings.selected.map(a => { const evidence = diagnoseApp(a, diagnostics); return <Alert key={a.id} severity={evidence.severity} sx={{ mt: 1 }}><Typography variant="body2">{a.name}：{evidence.label}（直连 {evidence.direct} / 代理 {evidence.proxied} / 拒绝 {evidence.blocked}）</Typography>{evidence.missingPaths.length > 0 && <Typography variant="caption">{evidence.missingPaths.length} 个程序路径缺少已加载的直连规则，工具会尝试自动修复；若出现提示，请按提示处理。</Typography>}{evidence.uncovered.length > 0 && <Typography variant="caption" display="block">发现 {evidence.uncovered.length} 个候选关联程序仍未直连，请展开软件的关联清单检查。</Typography>}</Alert>; })}
            {diagnostics.unidentifiedConnections > 0 && <Alert severity="warning" sx={{ mt: 1 }}>{diagnostics.unidentifiedConnections} 条连接无法识别程序路径，无法确定它们是否属于所选软件。当前结果仅覆盖已识别连接。</Alert>}
            <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>这是当前连接快照，不能保证所有辅助程序都已识别。修改规则不会改变旧连接；仍走代理时，重新打开被测软件后再检查。</Typography>
          </>}
        </Paper>
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="其他流量" size="small" sx={{ flex: 1 }} value={settings.otherTraffic} disabled={blocked || !ready} onChange={e => persist({ ...settings, otherTraffic: e.target.value as Settings['otherTraffic'] })}>
              <MenuItem value="proxy">使用代理（推荐）</MenuItem><MenuItem value="subscription">遵循订阅规则</MenuItem>
            </TextField>
            {settings.otherTraffic === 'proxy' && <TextField select label="代理组" size="small" sx={{ flex: 1 }} value={settings.proxyGroup} disabled={blocked || !ready} onChange={e => persist({ ...settings, proxyGroup: e.target.value })}>
              {[...new Set(['GLOBAL', ...(connection?.proxyGroups || []), settings.proxyGroup])].map(group => <MenuItem key={group} value={group}>{group === 'GLOBAL' ? 'GLOBAL · 沿用全局模式的选择' : group}</MenuItem>)}
            </TextField>}
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>{settings.otherTraffic === 'proxy' ? '所选软件直接联网，其余流量走指定代理组。Clash 仍需使用规则模式。GLOBAL 沿用全局模式的选择，请确保它及所选代理组选择的是可用代理节点，而不是 DIRECT。' : '未选软件遵循订阅规则，可能直连，也可能走代理。'}</Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}><Stack direction="row" divider={<Divider orientation="vertical" flexItem/>} spacing={3}>{[['识别到的软件', combined.length], ['已选择软件', settings.selected.length], ['关联进程', count]].map(([label, n]) => <Box key={label} sx={{ flex: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontSize={26} fontWeight={600}>{n}</Typography></Box>)}</Stack></Paper>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} mb={2}><TextField size="small" placeholder="搜索软件或进程" value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: 1 }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small"/></InputAdornment> }, htmlInput: { 'aria-label': '搜索软件或进程' } }}/><Button variant="outlined" startIcon={<Refresh/>} disabled={blocked} onClick={refresh}>{ready ? '重新扫描' : '重试初始化'}</Button><Button variant="outlined" startIcon={<Add/>} disabled={blocked || !ready} onClick={add}>添加软件</Button></Stack>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}><Tab label="全部软件"/><Tab label="运行中"/><Tab label="已选不使用代理"/></Tabs>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          {!filtered.length && <Box sx={{ p: 5, textAlign: 'center' }}><Typography color="text.secondary">{busy ? '正在读取…' : '没有符合条件的软件'}</Typography>{!busy && <Button disabled={blocked || !ready} onClick={add} sx={{ mt: 1 }}>选择程序文件添加</Button>}</Box>}
          {filtered.map((a, i) => <Box key={a.id}><Stack direction="row" spacing={2} alignItems="center" sx={{ p: 2 }}><Avatar variant="rounded" sx={{ bgcolor: selected.has(a.id) ? 'primary.main' : 'action.disabledBackground', color: selected.has(a.id) ? 'primary.contrastText' : 'text.secondary' }}>{a.name.slice(0, 1)}</Avatar><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600}>{a.name}</Typography><Typography variant="caption" color="text.secondary">{a.pathMissing ? '主程序路径失效 · 请重新添加' : a.running ? '运行中' : '未运行'} · {a.source}</Typography><Tooltip title={a.path}><Typography variant="caption" display="block" color="text.secondary" noWrap>{a.path}</Typography></Tooltip><Button size="small" sx={{ p: 0, mt: .5, fontSize: 12 }} endIcon={expanded.includes(a.id) ? <ExpandMore/> : <ChevronRight/>} aria-expanded={expanded.includes(a.id)} onClick={() => setExpanded(old => old.includes(a.id) ? old.filter(id => id !== a.id) : [...old, a.id])}>{a.processes.length} 个关联进程</Button></Box><Stack alignItems="center"><Switch checked={selected.has(a.id)} disabled={blocked || !ready} slotProps={{ input: { 'aria-label': `${a.name}不使用代理` } }} onChange={(_, checked) => persist({ ...settings, selected: checked ? [...settings.selected, a] : settings.selected.filter(b => b.id !== a.id) })}/><Typography variant="caption" color="text.secondary">{selected.has(a.id) ? '不使用代理' : settings.otherTraffic === 'proxy' ? '使用代理' : '订阅规则'}</Typography></Stack></Stack><Collapse in={expanded.includes(a.id)}><Box sx={{ px: 3, pb: 2 }}>{a.warnings.map(w => <Alert key={w} severity="warning" sx={{ mb: 1 }}>{w}</Alert>)}{(a.suggestedProcesses || []).filter(p => !a.processes.some(known => known.toLowerCase() === p.toLowerCase())).map(p => <Paper key={p} variant="outlined" sx={{ p: 1.5, mb: 1 }}><Typography variant="body2">候选关联程序 · 来自当前启动链</Typography><Typography sx={{ fontSize: 12, overflowWrap: "anywhere" }}>{p}</Typography><Button size="small" disabled={blocked || !selected.has(a.id)} onClick={() => includeCandidate(a, p)}>确认关联此程序</Button><Typography variant="caption" display="block">确认后会自动应用。未选中软件时，请先打开“不使用代理”开关。</Typography></Paper>)}<Typography variant="caption" color="text.secondary">按完整程序路径匹配；同名的其他软件不会被一起处理。</Typography>{a.processes.map(p => <Typography key={p} sx={{ fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere', mt: .5 }}>{p}</Typography>)}</Box></Collapse>{i < filtered.length - 1 && <Divider/>}</Box>)}
        </Paper>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={2} mt={3}><Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{result || '选择会自动保存并应用；不确定的关联程序才需要确认。'}</Typography><Stack direction="row" spacing={1}><Button startIcon={<Undo/>} disabled={blocked || !ready || (api.desktop && !connection?.managed)} onClick={() => { if (!operation.current) setConfirm('remove'); }}>撤销本工具规则</Button><Button variant="contained" disabled={blocked || !ready || (api.desktop && !connection?.found)} onClick={() => { if (!operation.current) setConfirm('apply'); }}>立即应用</Button></Stack></Stack>
        <Alert severity={reconnecting || connection?.found ? 'info' : 'warning'} sx={{ mt: 3 }}>{reconnecting ? '正在自动连接已保存的 Clash 配置，无需重新选择目录。' : connection?.message || '正在重试检测已保存的 Clash 配置目录'}{api.desktop && ready && !reconnecting && !connection?.found && <Button size="small" onClick={() => setPage('settings')}>连接 Clash</Button>}</Alert>
      </> : <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h6" mb={1}>Clash Verge Rev 配置目录</Typography><Typography color="text.secondary" variant="body2" mb={2}>自动检测标准目录；便携版可手动选择包含 profiles.yaml 的文件夹。</Typography><Stack direction="row" spacing={1}><TextField size="small" fullWidth disabled={blocked} value={draftDir} onChange={e => setDraftDir(e.target.value)} placeholder="留空使用自动检测" slotProps={{ htmlInput: { 'aria-label': 'Clash 配置目录' } }}/><Button variant="outlined" disabled={!api.desktop || blocked} onClick={chooseDir}><FolderOpen/></Button></Stack>{connection?.found && <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>当前连接目录：{connection.configDir}{!settings.configDir && '（自动检测）'}</Typography>}<Button variant="contained" sx={{ mt: 2 }} disabled={!api.desktop || blocked || !ready} onClick={saveDir}>检测并保存</Button><Divider sx={{ my: 3 }}/><Typography variant="h6" mb={1}>使用说明</Typography><Typography variant="body2" color="text.secondary" sx={{ lineHeight: 2 }}>1. 打开需要直连的软件，并打开“不使用代理”开关。<br/>2. 工具会自动保存规则并尝试在线应用，无需退出 Clash。<br/>3. 保持助手打开，它会定期补齐可信程序并检查新连接。<br/>4. 不确定的关联或配置冲突才需要处理提示。<br/>5. 关闭助手后停止检测，已保存的规则继续有效。</Typography><Alert severity="info" sx={{ mt: 2 }}>通过产品信息、已知安装结构和当前启动链发现关联程序。启动链候选需要确认后才能加入规则。使用“检查实际连接”查看当前路线；没有连接、路径无法读取或启动器已退出时，仍可能无法完整识别。应用成功仅表示规则已写入。</Alert><Typography variant="caption" display="block" mt={2} color="text.secondary">本工具独立开发，不是 Clash Verge 官方产品。在线应用会检查配置变化并备份；无法安全完成时保留选择并提示处理。</Typography></Paper>}
    </Box>
    <Dialog open={confirm !== null} onClose={() => !blocked && setConfirm(null)} maxWidth="sm" fullWidth><DialogTitle>{confirm === 'apply' ? '应用不使用代理的选择' : '撤销本工具规则'}</DialogTitle><DialogContent><Typography>{api.desktop ? '工具会保留原脚本和其他配置，先备份再尝试在线应用；无需退出 Clash。无法安全恢复订阅分流时会提示一次性退出后操作。' : '这次操作只模拟应用结果，不会修改 Clash。'}</Typography><Alert severity="info" sx={{ mt: 2 }}>{confirm === 'apply' ? `已选择 ${settings.selected.length} 个软件，当前识别 ${count} 个进程。应用前会再扫描这些软件的程序目录。其他流量：${settings.otherTraffic === 'proxy' ? '使用代理组 ' + settings.proxyGroup : '遵循订阅规则'}。` : '保留软件选择，移除本工具写入的规则。原有订阅及其他规则保持有效。'}</Alert></DialogContent><DialogActions><Button disabled={blocked} onClick={() => setConfirm(null)}>取消</Button><Button disabled={blocked} variant="contained" onClick={execute}>{api.desktop ? '继续' : '模拟继续'}</Button></DialogActions></Dialog>
    <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast('')} message={toast}/>
  </Box></ThemeProvider>;
}
