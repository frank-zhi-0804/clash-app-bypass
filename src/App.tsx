import { useEffect, useMemo, useState } from 'react';
import { Alert, Avatar, Box, Button, Chip, CircularProgress, Collapse, CssBaseline, Dialog, DialogActions, DialogContent, DialogTitle, Divider, IconButton, InputAdornment, List, ListItemButton, ListItemIcon, ListItemText, MenuItem, Paper, Snackbar, Stack, Switch, Tab, Tabs, TextField, ThemeProvider, Tooltip, Typography } from '@mui/material';
import { Apps, Add, ChevronRight, DarkMode, FolderOpen, LightMode, Refresh, Search, Settings as SettingsIcon, Undo, ExpandMore } from '@mui/icons-material';
import { open } from '@tauri-apps/plugin-dialog';
import * as api from './api';
import type { AppEntry, Integration, Settings } from './types';
import { makeTheme } from './theme';
import { applicationStatus, readWorkspace, routingFingerprint } from './workflow';

export default function App() {
  const [settings, setSettings] = useState<Settings>({ selected: [], configDir: '', dark: false, otherTraffic: 'proxy', proxyGroup: 'GLOBAL' });
  const [apps, setApps] = useState<AppEntry[]>([]);
  const [connection, setConnection] = useState<Integration>();
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
  const [draftDir, setDraftDir] = useState('');
  const theme = useMemo(() => makeTheme(settings.dark), [settings.dark]);
  const status = applicationStatus(settings, connection, api.desktop);
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
  function observeRestart(next: Settings, integration: Integration): Settings {
    return next.applied?.pendingRestart && integration.running
      ? { ...next, applied: { ...next.applied, pendingRestart: false } } : next;
  }
  async function initialize(isActive = () => true) {
    setBusy('正在读取软件清单…'); setError('');
    try {
      const workspace = await readWorkspace(api.loadSettings, api.scanApps, stored => api.integration(stored.configDir));
      if (!isActive()) return;
      let next = workspace.settings;
      const errors: string[] = [];
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(`软件扫描失败：${String(workspace.apps.reason)}`);
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
        next = observeRestart(next, workspace.integration.value);
      } else errors.push(`Clash 检测失败：${String(workspace.integration.reason)}`);
      setSettings(next); setDraftDir(next.configDir); setReady(true);
      if (errors.length) setError(errors.join('；'));
      if (next !== workspace.settings) await api.saveSettings(next);
    } catch (e) { if (isActive()) setError(String(e)); }
    finally { if (isActive()) setBusy(''); }
  }
  useEffect(() => { let active = true; void initialize(() => active); return () => { active = false; }; }, []);
  async function persist(next: Settings) { setBusy('正在保存选择…'); setError(''); try {
    await api.saveSettings(next); setSettings(next);
    if (routingFingerprint(next) !== routingFingerprint(settings)) setResult('选择已保存，尚未应用到 Clash');
  } catch (e) { setError(String(e)); } finally { setBusy(''); } }
  async function refresh() {
    if (!ready) { await initialize(); return; }
    setBusy('正在扫描应用和相关进程…'); setError('');
    try {
      const workspace = await readWorkspace(() => Promise.resolve(settings), api.scanApps, stored => api.integration(stored.configDir));
      const errors: string[] = [];
      if (workspace.apps.status === 'fulfilled') setApps(workspace.apps.value);
      else errors.push(`软件扫描失败：${String(workspace.apps.reason)}`);
      let next = settings;
      if (workspace.integration.status === 'fulfilled') {
        setConnection(workspace.integration.value);
        next = observeRestart(next, workspace.integration.value);
      } else errors.push(`Clash 检测失败：${String(workspace.integration.reason)}`);
      try { next = { ...next, selected: await api.refreshSelected(next.selected) }; }
      catch (e) { errors.push(`所选软件刷新失败：${String(e)}`); }
      await api.saveSettings(next); setSettings(next);
      setResult(routingFingerprint(next) !== routingFingerprint(settings) ? '已更新关联程序，当前选择需重新应用' : '已刷新软件清单与 Clash 状态');
      if (errors.length) setError(errors.join('；')); else setToast('扫描完成，已检查所选软件及辅助程序路径');
    } catch (e) { setError(String(e)); } finally { setBusy(''); }
  }
  async function add() { if (!api.desktop) { setToast('桌面版可选择 .exe 文件，浏览器版仅展示示例应用'); return; }
    try { const path = await open({ multiple: false, filters: [{ name: 'Windows 应用', extensions: ['exe'] }] }); if (typeof path !== 'string') return;
      setBusy('正在识别软件…'); const entry = await api.inspectApp(path); setApps(old => [...old.filter(a => a.id !== entry.id), entry]); setToast('已添加软件，打开“不使用代理”开关即可选择');
    } catch (e) { setError(String(e)); } finally { setBusy(''); } }
  async function chooseDir() { try { const dir = await open({ directory: true, multiple: false }); if (typeof dir === 'string') setDraftDir(dir); } catch(e) { setError(String(e)); } }
  async function saveDir() { setBusy('正在检测 Clash…'); setError(''); try { const status = await api.integration(draftDir); if (!status.found) throw new Error(status.message); const changed = settings.configDir.toLowerCase() !== status.configDir.toLowerCase(); const next = { ...settings, configDir: status.configDir, applied: changed ? null : settings.applied }; await api.saveSettings(next); setSettings(next); setDraftDir(status.configDir); setConnection(status); setToast('Clash 配置目录已连接'); } catch(e) { setError(String(e)); } finally { setBusy(''); } }
  async function execute() { const action = confirm; setConfirm(null); setBusy(action === 'apply' ? '正在写入本工具规则…' : '正在撤销本工具规则…'); setError(''); try {
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
    next.applied = { fingerprint: routingFingerprint(next), pendingRestart: api.desktop, hasRules: action === 'apply' && (chosen.length > 0 || settings.otherTraffic === 'proxy') };
    setSettings(next); setResult(res.message); setToast(res.message);
    // A settings/detection failure after writing must not masquerade as a failed rule write.
    const followup = await Promise.allSettled([api.saveSettings(next), api.integration(settings.configDir)]);
    const warnings: string[] = [];
    if (followup[0].status === 'rejected') warnings.push('规则操作已完成，但状态保存失败；请重试刷新');
    if (followup[1].status === 'fulfilled') setConnection(followup[1].value);
    else warnings.push('规则操作已完成，但 Clash 状态检测失败；请重试刷新');
    if (warnings.length) setError(warnings.join('；'));
  } catch(e) { setError(String(e)); } finally { setBusy(''); } }
  return <ThemeProvider theme={theme}><CssBaseline/><Box sx={{ display: 'flex', minHeight: '100vh' }}>
    <Paper square sx={{ width: 205, flexShrink: 0, borderRight: 1, borderColor: 'divider', bgcolor: settings.dark ? '#1e202a' : '#eef0f7', p: 2.5, display: { xs: 'none', md: 'flex' }, flexDirection: 'column' }}>
      <Stack direction="row" spacing={1.2} alignItems="center" sx={{ mb: 5 }}><Box component="img" src="/app-icon.png" alt="直连助手图标" sx={{ width: 36, height: 36, objectFit: 'contain' }}/><Typography fontWeight={700} fontSize={19}>直连助手</Typography></Stack>
      <List disablePadding>{[['apps', '应用分流'], ['settings', '设置']].map(([id, label]) => <ListItemButton key={id} selected={page === id} onClick={() => setPage(id)} sx={{ borderRadius: 2, mb: 1 }}><ListItemIcon sx={{ minWidth: 34 }}>{id === 'apps' ? <Apps/> : <SettingsIcon/>}</ListItemIcon><ListItemText primary={label}/></ListItemButton>)}</List>
      <Box sx={{ mt: 'auto', pt: 4 }}><Typography variant="caption" color="text.secondary">Clash App Bypass · v0.1.3<br/>Clash Verge Rev 第三方助手</Typography></Box>
    </Paper>
    <Box component="main" sx={{ flex: 1, minWidth: 0, p: { xs: 2, md: 4 }, maxWidth: 1100, mx: 'auto' }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={3}><Typography variant="h4">{page === 'apps' ? '不使用代理的软件' : '设置'}</Typography><Stack direction="row" alignItems="center" spacing={1}><Chip size="small" variant="outlined" color={api.desktop ? 'primary' : 'warning'} label={api.desktop ? '桌面版' : '浏览器演示'}/><Tooltip title="切换主题"><IconButton disabled={!!busy || !ready} onClick={() => persist({ ...settings, dark: !settings.dark })}>{settings.dark ? <LightMode/> : <DarkMode/>}</IconButton></Tooltip><IconButton sx={{ display: { md: 'none' } }} onClick={() => setPage(page === 'apps' ? 'settings' : 'apps')} aria-label="切换设置页面"><SettingsIcon/></IconButton></Stack></Stack>
      {error && <Alert severity="error" onClose={() => setError('')} action={<Button color="inherit" size="small" disabled={!!busy} onClick={refresh}>重试</Button>} sx={{ mb: 2, overflowWrap: 'anywhere' }}>{error}</Alert>}
      {!api.desktop && <Alert severity="info" sx={{ mb: 2 }}>浏览器中展示示例数据。真实扫描与配置应用需要运行桌面版。</Alert>}
      {busy && <Stack direction="row" spacing={1} alignItems="center" mb={2} role="status"><CircularProgress size={17}/><Typography variant="body2">{busy}</Typography></Stack>}
      {page === 'apps' ? <>
        <Alert severity={status.label === '规则已写入' ? 'success' : 'info'} sx={{ mb: 2 }}><Stack direction="row" spacing={1} alignItems="center"><Chip size="small" label={status.label}/><Typography variant="body2">{status.message}</Typography>{settings.applied?.pendingRestart && <Button size="small" disabled={!!busy} onClick={refresh}>已重启，检查状态</Button>}</Stack></Alert>
        <Typography color="text.secondary" mb={3}>打开开关，让这些软件不使用代理；其他流量按下方设置处理。</Typography>
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={2}>
            <TextField select label="其他流量" size="small" sx={{ flex: 1 }} value={settings.otherTraffic} disabled={!!busy || !ready} onChange={e => persist({ ...settings, otherTraffic: e.target.value as Settings['otherTraffic'] })}>
              <MenuItem value="proxy">使用代理（推荐）</MenuItem><MenuItem value="subscription">遵循订阅规则</MenuItem>
            </TextField>
            {settings.otherTraffic === 'proxy' && <TextField select label="代理组" size="small" sx={{ flex: 1 }} value={settings.proxyGroup} disabled={!!busy || !ready} onChange={e => persist({ ...settings, proxyGroup: e.target.value })}>
              {[...new Set(['GLOBAL', ...(connection?.proxyGroups || []), settings.proxyGroup])].map(group => <MenuItem key={group} value={group}>{group === 'GLOBAL' ? 'GLOBAL · 沿用全局模式的选择' : group}</MenuItem>)}
            </TextField>}
          </Stack>
          <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1.5 }}>{settings.otherTraffic === 'proxy' ? '所选软件直接联网，其余流量走指定代理组。Clash 仍需使用规则模式。GLOBAL 沿用全局模式的选择，请确保它及所选代理组选择的是可用代理节点，而不是 DIRECT。' : '未选软件遵循订阅规则，可能直连，也可能走代理。'}</Typography>
        </Paper>
        <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}><Stack direction="row" divider={<Divider orientation="vertical" flexItem/>} spacing={3}>{[['识别到的软件', combined.length], ['已选择软件', settings.selected.length], ['关联进程', count]].map(([label, n]) => <Box key={label} sx={{ flex: 1 }}><Typography variant="caption" color="text.secondary">{label}</Typography><Typography fontSize={26} fontWeight={600}>{n}</Typography></Box>)}</Stack></Paper>
        <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} mb={2}><TextField size="small" placeholder="搜索软件或进程" value={query} onChange={e => setQuery(e.target.value)} sx={{ flex: 1 }} slotProps={{ input: { startAdornment: <InputAdornment position="start"><Search fontSize="small"/></InputAdornment> }, htmlInput: { 'aria-label': '搜索软件或进程' } }}/><Button variant="outlined" startIcon={<Refresh/>} disabled={!!busy} onClick={refresh}>{ready ? '重新扫描' : '重试初始化'}</Button><Button variant="outlined" startIcon={<Add/>} disabled={!!busy || !ready} onClick={add}>添加软件</Button></Stack>
        <Tabs value={tab} onChange={(_, v) => setTab(v)} sx={{ mb: 1 }}><Tab label="全部软件"/><Tab label="运行中"/><Tab label="已选不使用代理"/></Tabs>
        <Paper variant="outlined" sx={{ overflow: 'hidden' }}>
          {!filtered.length && <Box sx={{ p: 5, textAlign: 'center' }}><Typography color="text.secondary">{busy ? '正在读取…' : '没有符合条件的软件'}</Typography>{!busy && <Button disabled={!ready} onClick={add} sx={{ mt: 1 }}>选择程序文件添加</Button>}</Box>}
          {filtered.map((a, i) => <Box key={a.id}><Stack direction="row" spacing={2} alignItems="center" sx={{ p: 2 }}><Avatar variant="rounded" sx={{ bgcolor: selected.has(a.id) ? 'primary.main' : 'action.disabledBackground', color: selected.has(a.id) ? 'primary.contrastText' : 'text.secondary' }}>{a.name.slice(0, 1)}</Avatar><Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600}>{a.name}</Typography><Typography variant="caption" color="text.secondary">{a.pathMissing ? '主程序路径失效 · 请重新添加' : a.running ? '运行中' : '未运行'} · {a.source}</Typography><Tooltip title={a.path}><Typography variant="caption" display="block" color="text.secondary" noWrap>{a.path}</Typography></Tooltip><Button size="small" sx={{ p: 0, mt: .5, fontSize: 12 }} endIcon={expanded.includes(a.id) ? <ExpandMore/> : <ChevronRight/>} aria-expanded={expanded.includes(a.id)} onClick={() => setExpanded(old => old.includes(a.id) ? old.filter(id => id !== a.id) : [...old, a.id])}>{a.processes.length} 个关联进程</Button></Box><Stack alignItems="center"><Switch checked={selected.has(a.id)} disabled={!!busy || !ready} slotProps={{ input: { 'aria-label': `${a.name}不使用代理` } }} onChange={(_, checked) => persist({ ...settings, selected: checked ? [...settings.selected, a] : settings.selected.filter(b => b.id !== a.id) })}/><Typography variant="caption" color="text.secondary">{selected.has(a.id) ? '不使用代理' : settings.otherTraffic === 'proxy' ? '使用代理' : '订阅规则'}</Typography></Stack></Stack><Collapse in={expanded.includes(a.id)}><Box sx={{ px: 3, pb: 2 }}>{a.warnings.map(w => <Alert key={w} severity="warning" sx={{ mb: 1 }}>{w}</Alert>)}<Typography variant="caption" color="text.secondary">按完整程序路径匹配；同名的其他软件不会被一起处理。</Typography>{a.processes.map(p => <Typography key={p} sx={{ fontFamily: 'monospace', fontSize: 12, overflowWrap: 'anywhere', mt: .5 }}>{p}</Typography>)}</Box></Collapse>{i < filtered.length - 1 && <Divider/>}</Box>)}
        </Paper>
        <Stack direction={{ xs: 'column', sm: 'row' }} alignItems={{ sm: 'center' }} justifyContent="space-between" spacing={2} mt={3}><Typography variant="caption" color="text.secondary" sx={{ flex: 1 }}>{result || '选择会自动保存。点击应用后才会修改 Clash 规则。'}</Typography><Stack direction="row" spacing={1}><Button startIcon={<Undo/>} disabled={!!busy || !ready || (api.desktop && !connection?.managed)} onClick={() => setConfirm('remove')}>撤销本工具规则</Button><Button variant="contained" disabled={!!busy || !ready || (api.desktop && !connection?.found)} onClick={() => setConfirm('apply')}>应用到 Clash</Button></Stack></Stack>
        <Alert severity={connection?.found ? 'info' : 'warning'} sx={{ mt: 3 }}>{connection?.message || '尚未检测 Clash 配置目录'}{api.desktop && !connection?.found && <Button size="small" onClick={() => setPage('settings')}>连接 Clash</Button>}</Alert>
      </> : <Paper variant="outlined" sx={{ p: 3 }}><Typography variant="h6" mb={1}>Clash Verge Rev 配置目录</Typography><Typography color="text.secondary" variant="body2" mb={2}>自动检测标准目录；便携版可手动选择包含 profiles.yaml 的文件夹。</Typography><Stack direction="row" spacing={1}><TextField size="small" fullWidth value={draftDir} onChange={e => setDraftDir(e.target.value)} placeholder="留空使用自动检测" slotProps={{ htmlInput: { 'aria-label': 'Clash 配置目录' } }}/><Button variant="outlined" disabled={!api.desktop || !!busy} onClick={chooseDir}><FolderOpen/></Button></Stack><Button variant="contained" sx={{ mt: 2 }} disabled={!api.desktop || !!busy || !ready} onClick={saveDir}>检测并保存</Button><Divider sx={{ my: 3 }}/><Typography variant="h6" mb={1}>使用说明</Typography><Typography variant="body2" color="text.secondary" sx={{ lineHeight: 2 }}>1. 选择不使用代理的软件。<br/>2. 从系统托盘完全退出 Clash Verge。<br/>3. 点击“应用到 Clash”，然后重新打开 Clash。<br/>4. 在 Clash 中使用规则模式；若需接管不遵循系统代理的应用，可开启 TUN。<br/>5. 在 Clash 的连接页面确认新连接使用 DIRECT。</Typography><Alert severity="info" sx={{ mt: 2 }}>第一版关联程序目录中产品信息相同或已知的辅助程序。不会自动关联目录外的共享服务，也不会断开现有连接。应用成功表示规则已写入，并不代表所有连接已验证直连。</Alert><Typography variant="caption" display="block" mt={2} color="text.secondary">本工具独立开发，不是 Clash Verge 官方产品。第一版需要退出后写入配置，避免与 Clash 同时保存脚本。</Typography></Paper>}
    </Box>
    <Dialog open={confirm !== null} onClose={() => !busy && setConfirm(null)} maxWidth="sm" fullWidth><DialogTitle>{confirm === 'apply' ? '应用不使用代理的选择' : '撤销本工具规则'}</DialogTitle><DialogContent><Typography>{api.desktop ? '请先从系统托盘完全退出 Clash Verge。工具会保留原脚本，仅管理自己的规则段，并自动备份。完成后重新打开 Clash Verge。' : '这次操作只模拟应用结果，不会修改 Clash。'}</Typography><Alert severity="info" sx={{ mt: 2 }}>{confirm === 'apply' ? `已选择 ${settings.selected.length} 个软件，当前识别 ${count} 个进程。应用前会再扫描这些软件的程序目录。其他流量：${settings.otherTraffic === 'proxy' ? '使用代理组 ' + settings.proxyGroup : '遵循订阅规则'}。` : '保留软件选择，移除本工具写入的规则。原有订阅及其他规则保持有效。'}</Alert></DialogContent><DialogActions><Button onClick={() => setConfirm(null)}>取消</Button><Button variant="contained" onClick={execute}>{api.desktop ? '已退出，继续' : '模拟继续'}</Button></DialogActions></Dialog>
    <Snackbar open={!!toast} autoHideDuration={5000} onClose={() => setToast('')} message={toast}/>
  </Box></ThemeProvider>;
}
