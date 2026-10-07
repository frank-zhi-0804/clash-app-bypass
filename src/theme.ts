import { createTheme } from '@mui/material/styles';
export const makeTheme = (dark: boolean) => createTheme({
  palette: { mode: dark ? 'dark' : 'light', primary: { main: dark ? '#9ca7ff' : '#5865d8' }, background: { default: dark ? '#191b24' : '#f5f6fa', paper: dark ? '#222531' : '#ffffff' } },
  typography: { fontFamily: '"Segoe UI", "Microsoft YaHei", sans-serif', h4: { fontSize: 26, fontWeight: 600 }, button: { textTransform: 'none' } },
  shape: { borderRadius: 10 },
  components: {
    MuiButton: { defaultProps: { disableElevation: true }, styleOverrides: { root: { borderRadius: 8 } } },
    MuiPaper: { defaultProps: { elevation: 0 } },
    MuiTooltip: { defaultProps: { arrow: true } },
  },
});
