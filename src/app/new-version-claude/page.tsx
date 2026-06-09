import { AppShell } from '@/components/layout/AppShell';
import { NewVersionClaudeScreen } from '@/components/new-version-claude/NewVersionClaudeScreen';

export const metadata = {
  title: 'New Version Claude · HelioSat',
};

export default function NewVersionClaudePage() {
  return (
    <AppShell>
      <NewVersionClaudeScreen />
    </AppShell>
  );
}
