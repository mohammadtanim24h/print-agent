import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { JOB_STATUS_META, JobStatusPill } from '../../src/renderer/src/ui/status';

describe('job status wording contract (api-contract §3.1)', () => {
  it('labels every job status and never claims physical printing', () => {
    const expected: Record<string, string> = {
      accepted: 'Queued on device',
      rendered: 'Rendered',
      sending: 'Sending',
      sent_to_printer: 'Sent to printer',
      printer_ack: 'Printer acknowledged',
      completed: 'Sent to printer (hand-off)',
      failed: 'Failed',
      ambiguous: 'Outcome unknown — verify',
      rejected: 'Rejected',
    };
    for (const [status, label] of Object.entries(expected)) {
      const { unmount } = render(<JobStatusPill status={status as keyof typeof JOB_STATUS_META} />);
      const pill = document.querySelector('.pill');
      expect(pill).not.toBeNull();
      expect(pill?.textContent).toContain(label);
      // G8: no UI state may claim a physical print.
      expect(pill?.textContent.toLowerCase()).not.toContain('printed');
      unmount();
    }
  });

  it('completed-status tooltip explains hand-off semantics explicitly', () => {
    const { container } = render(<JobStatusPill status="completed" />);
    const pill = container.querySelector('.pill');
    expect(pill?.getAttribute('title')).toMatch(/never confirmed|not a guarantee|not confirmed/i);
    expect(pill?.getAttribute('title')).toMatch(/hand-off/i);
  });

  it('pairs an icon with every status so color is never the only signal', () => {
    const icons = new Set(Object.values(JOB_STATUS_META).map((meta) => meta.Icon));
    // Several distinct shapes must exist across statuses (WCAG 1.4.1).
    expect(icons.size).toBeGreaterThanOrEqual(4);
    for (const status of Object.keys(JOB_STATUS_META)) {
      const { container, unmount } = render(
        <JobStatusPill status={status as keyof typeof JOB_STATUS_META} />,
      );
      // every pill renders an svg icon plus its text label
      expect(container.querySelector('.pill svg')).not.toBeNull();
      expect(
        container.querySelector('.pill span:last-child')?.textContent.length ?? 0,
      ).toBeGreaterThan(0);
      unmount();
    }
  });
});
