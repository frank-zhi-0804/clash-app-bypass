import { useEffect, useState } from 'react';
import { Alert, Box, Button, Chip, IconButton, Paper, Stack, TextField, Tooltip, Typography } from '@mui/material';
import { DeleteOutline } from '@mui/icons-material';
import * as api from './api';
import type { NormalizedWebsite } from './types';
import type { RoutingSnapshot } from './routingDiagnostics';
import { websiteRuleStatus } from './websites';

interface Props {
  websites: string[];
  disabled: boolean;
  diagnostics?: RoutingSnapshot;
  onAdd(domain: string): Promise<boolean>;
  onRemove(domain: string): Promise<void>;
  onCheck(): void;
}

export default function WebsitePanel({ websites, disabled, diagnostics, onAdd, onRemove, onCheck }: Props) {
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<{ input: string; value: NormalizedWebsite }>();
  const [inputError, setInputError] = useState<{ input: string; message: string }>();
  const [normalizing, setNormalizing] = useState(false);
  const [adding, setAdding] = useState(false);
  const raw = input.trim();
  const website = preview?.input === raw ? preview.value : undefined;
  const error = inputError?.input === raw ? inputError.message : '';
  const duplicate = !!website && websites.some(domain => domain.toLowerCase() === website.domain.toLowerCase());

  useEffect(() => {
    if (!raw || !api.desktop) { setNormalizing(false); return; }
    let active = true;
    setNormalizing(true);
    const timer = setTimeout(() => {
      void api.normalizeWebsite(raw).then(value => {
        if (active) { setPreview({ input: raw, value }); setInputError(undefined); }
      }).catch(error => {
        if (active) { setPreview(undefined); setInputError({ input: raw, message: error instanceof Error ? error.message : String(error) }); }
      }).finally(() => { if (active) setNormalizing(false); });
    }, 250);
    return () => { active = false; clearTimeout(timer); };
  }, [raw]);

  async function add() {
    if (!website || duplicate || disabled || adding || normalizing) return;
    const entered = input;
    setAdding(true);
    try {
      if (await onAdd(website.domain)) setInput(current => current === entered ? '' : current);
    } finally { setAdding(false); }
  }

  return <>
    <Typography color="text.secondary" mb={3}>粘贴网址，工具会自动整理成网站主域名。添加后，这个域名及其所有子域名都会使用直连规则。</Typography>
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      {!api.desktop && <Alert severity="info" sx={{ mb: 2 }}>桌面版可以自动整理网站网址；这里展示网站直连页面。</Alert>}
      <Stack component="form" onSubmit={event => { event.preventDefault(); void add(); }} direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
        <TextField fullWidth label="网站网址或域名" placeholder="例如 https://news.example.com/article" value={input} onChange={event => setInput(event.target.value)} error={!!error} helperText={error || (normalizing ? '正在整理网址…' : '网址中的路径、端口和参数不会影响整个网站的选择。')} slotProps={{ htmlInput: { 'aria-label': '网站网址或域名' } }}/>
        <Button type="submit" variant="contained" disabled={!api.desktop || disabled || adding || normalizing || !website || duplicate} sx={{ mt: { sm: 1 }, whiteSpace: 'nowrap' }}>添加网站</Button>
      </Stack>
      {website && !normalizing && <Box sx={{ mt: 1.5 }}>
        <Typography variant="body2">{website.host === website.domain ? website.domain : `${website.host} → ${website.domain}`}</Typography>
        <Typography variant="caption" color={duplicate ? 'warning.main' : 'text.secondary'}>{duplicate ? '这个网站已经在直连列表中。' : `覆盖 ${website.domain} 及其所有子域名；添加后自动保存并应用。`}</Typography>
      </Box>}
    </Paper>
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2} spacing={1}>
        <Typography fontWeight={600}>直连网站 · {websites.length}</Typography>
        <Button disabled={!api.desktop || disabled || !websites.length} onClick={onCheck}>检查网站规则</Button>
      </Stack>
      {!websites.length && <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>还没有添加网站，粘贴一个网址即可开始。</Typography>}
      {websites.map(domain => {
        const status = websiteRuleStatus(domain, diagnostics);
        return <Stack key={domain} direction="row" alignItems="center" spacing={1.5} sx={{ py: 1.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>{domain}</Typography><Typography variant="caption" color="text.secondary">包含该域名及所有子域名</Typography></Box>
          <Chip size="small" variant="outlined" color={status.severity} label={status.label}/>
          <Tooltip title="取消网站直连"><IconButton disabled={disabled || adding} aria-label={`${domain}取消直连`} onClick={() => onRemove(domain)}><DeleteOutline/></IconButton></Tooltip>
        </Stack>;
      })}
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>这里检查规则是否已加载；请用浏览器访问网站验证实际效果。修改规则后，新连接才会使用新路线。</Typography>
    </Paper>
    <Alert severity="info" sx={{ mt: 3 }}>网站使用的其他独立域名，例如登录、图片或 CDN 域名，需要分别添加。</Alert>
  </>;
}
