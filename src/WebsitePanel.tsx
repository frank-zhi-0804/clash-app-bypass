import { useUiTranslation, translateMessage as display } from './i18n';
import { messageFromError } from './messages';
import type { DisplayMessage } from './types';
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
  const t = useUiTranslation();
  const [input, setInput] = useState('');
  const [preview, setPreview] = useState<{ input: string; value: NormalizedWebsite }>();
  const [inputError, setInputError] = useState<{ input: string; message: DisplayMessage }>();
  const [normalizing, setNormalizing] = useState(false);
  const [adding, setAdding] = useState(false);
  const raw = input.trim();
  const website = preview?.input === raw ? preview.value : undefined;
  const error = inputError?.input === raw ? display(inputError.message) : '';
  const duplicate = !!website && websites.some(domain => domain.toLowerCase() === website.domain.toLowerCase());

  useEffect(() => {
    if (!raw || !api.desktop) { setNormalizing(false); return; }
    let active = true;
    setNormalizing(true);
    const timer = setTimeout(() => {
      void api.normalizeWebsite(raw).then(value => {
        if (active) { setPreview({ input: raw, value }); setInputError(undefined); }
      }).catch(error => {
        if (active) { setPreview(undefined); setInputError({ input: raw, message: messageFromError(error) }); }
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
    <Typography color="text.secondary" mb={3}>{t('website.help')}</Typography>
    <Paper variant="outlined" sx={{ p: 2.5, mb: 3 }}>
      {!api.desktop && <Alert severity="info" sx={{ mb: 2 }}>{t('website.demo')}</Alert>}
      <Stack component="form" onSubmit={event => { event.preventDefault(); void add(); }} direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
        <TextField fullWidth label={t('website.input')} placeholder={t('website.placeholder')} value={input} onChange={event => setInput(event.target.value)} error={!!error} helperText={error || (normalizing ? t('website.normalizing') : t('website.inputHelp'))} slotProps={{ htmlInput: { 'aria-label': t('website.input') } }}/>
        <Button type="submit" variant="contained" disabled={!api.desktop || disabled || adding || normalizing || !website || duplicate} sx={{ mt: { sm: 1 }, whiteSpace: 'nowrap' }}>{t('website.add')}</Button>
      </Stack>
      {website && !normalizing && <Box sx={{ mt: 1.5 }}>
        <Typography variant="body2">{website.host === website.domain ? website.domain : `${website.host} → ${website.domain}`}</Typography>
        <Typography variant="caption" color={duplicate ? 'warning.main' : 'text.secondary'}>{duplicate ? t('website.duplicate') : t('website.scope', { domain: website.domain })}</Typography>
      </Box>}
    </Paper>
    <Paper variant="outlined" sx={{ p: 2.5 }}>
      <Stack direction="row" justifyContent="space-between" alignItems="center" mb={2} spacing={1}>
        <Typography fontWeight={600}>{t('website.count', { count: websites.length })}</Typography>
        <Button disabled={!api.desktop || disabled || !websites.length} onClick={onCheck}>{t('website.check')}</Button>
      </Stack>
      {!websites.length && <Typography color="text.secondary" sx={{ py: 3, textAlign: 'center' }}>{t('website.empty')}</Typography>}
      {websites.map(domain => {
        const status = websiteRuleStatus(domain, diagnostics);
        return <Stack key={domain} direction="row" alignItems="center" spacing={1.5} sx={{ py: 1.5 }}>
          <Box sx={{ flex: 1, minWidth: 0 }}><Typography fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>{domain}</Typography><Typography variant="caption" color="text.secondary">{t('website.includes')}</Typography></Box>
          <Chip size="small" variant="outlined" color={status.severity} label={display({ key: status.label })}/>
          <Tooltip title={t('website.remove')}><IconButton disabled={disabled || adding} aria-label={t('website.removeAria', { domain })} onClick={() => onRemove(domain)}><DeleteOutline/></IconButton></Tooltip>
        </Stack>;
      })}
      <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 2 }}>{t('website.checkHelp')}</Typography>
    </Paper>
    <Alert severity="info" sx={{ mt: 3 }}>{t('website.independent')}</Alert>
  </>;
}
