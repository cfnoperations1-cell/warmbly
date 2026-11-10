import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { UserContext } from "@/hooks/context/user";
import { ConfirmContext } from "@/hooks/context/confirm";
import { useAppStore } from "@/stores/useAppStore";
import type Inbox from "@/lib/api/models/app/emails/Inbox";
import InboxDetails from "./InboxDetails";

const reauthEmailOAuth = vi.hoisted(() => vi.fn());
const authorizeEmailInPopup = vi.hoisted(() => vi.fn());
const onboardOAuthFinish = vi.hoisted(() => vi.fn());
const accountStatus = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api/client/Request", () => ({ default: () => new Promise(() => {}) }));
vi.mock("@/hooks/PresenceProvider", () => ({ usePresenceResource: () => {} }));
vi.mock("@/components/app/presence/ResourceViewers", () => ({ default: () => null }));
vi.mock("@/components/app/advisor/AdvisorStrip", () => ({ default: () => null }));
vi.mock("@/hooks/useCloudPool", () => ({
    default: () => ({ connected: false, selfHosted: false, loading: false, unavailable: false, isEnrolled: () => false, rowFor: () => ({ managed: false }) }),
}));
vi.mock("@/lib/api/hooks/auth/useAuthConfig", () => ({ default: () => ({ isLoading: false, isError: false }) }));
vi.mock("./SendingBehaviorTab", () => ({ default: () => <p>Sending behavior</p> }));
vi.mock("@/lib/api/hooks/app/analytics/useAccountStatus", () => ({ default: () => accountStatus() }));
vi.mock("@/lib/api/client/app/emails/reauthEmailOAuth", () => ({ default: (...args: unknown[]) => reauthEmailOAuth(...args) }));
vi.mock("@/lib/emails/emailOAuthPopup", () => ({ authorizeEmailInPopup: (...args: unknown[]) => authorizeEmailInPopup(...args) }));
vi.mock("@/lib/api/client/app/emails/onboardOAuthFinish", () => ({ default: (...args: unknown[]) => onboardOAuthFinish(...args) }));

function mailbox(over: Partial<Inbox> = {}): Inbox {
    return {
        id: "mbx", email: "ada@workspace.test", name: "Ada", signature_plain: "", signature_html: "", signature_sync: false, signature_code: false,
        send_as_email: "", tags: [], provider: "gmail", auth_method: "oauth", status: "active", last_synced_at: new Date(), campaign_limit: 50, min_wait_time: 60,
        reply_to: "", save_to_sent: false, tracking_domain: "", tracking_domain_verified: false,
        auth_state: "unknown", auth_spf: false, auth_dkim: false, auth_dmarc: false,
        warmup_base: 5, warmup_max: 20, warmup_increase: 2, warmup_reply_rate: 30, created_at: new Date(), updated_at: new Date(),
        ...over,
    };
}

function Page({ box = mailbox() }: { box?: Inbox }) {
    const profile = { user: { id: "account-user" } } as ComponentProps<typeof UserContext.Provider>["value"];
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return (
        <QueryClientProvider client={client}>
            <UserContext.Provider value={profile}>
                <ConfirmContext.Provider value={{ show: vi.fn(), setLoading: vi.fn(), setShow: vi.fn() }}>
                    <InboxDetails emails={[box]} view={box.id} setView={() => {}} />
                </ConfirmContext.Provider>
            </UserContext.Provider>
        </QueryClientProvider>
    );
}

const reauthButton = () => screen.queryByRole("button", { name: "Re-authorize with Google" });

describe("Google OAuth re-authorization", () => {
    beforeEach(() => {
        sessionStorage.clear();
        HTMLElement.prototype.scrollBy = vi.fn();
        reauthEmailOAuth.mockReset();
        authorizeEmailInPopup.mockReset();
        onboardOAuthFinish.mockReset();
        accountStatus.mockReset();
        accountStatus.mockReturnValue({ data: undefined, isPending: true, isError: false });
        useAppStore.setState({ currentOrganization: { id: "workspace", name: "Workspace", role: "owner" } });
    });

    it("offers re-authorization on a healthy Google OAuth mailbox", () => {
        const page = render(<Page />);
        expect(screen.getByText("Renew Google access")).toBeInTheDocument();
        expect(reauthButton()).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        expect(screen.getByText("Renew Google access")).toBeInTheDocument();
        expect(reauthButton()).toBeInTheDocument();

        page.rerender(<Page box={mailbox({ auth_method: "" })} />);
        fireEvent.click(screen.getByRole("button", { name: "Overview" }));
        expect(reauthButton()).toBeInTheDocument();
    });

    it.each([
        { provider: "gmail", auth_method: "delegated" },
        { provider: "gmail", auth_method: "app_password" },
        { provider: "gmail", auth_method: "password" },
        { provider: "smtp_imap", auth_method: "app_password", mail_host: "google_workspace" },
        { provider: "smtp_imap", auth_method: "password" },
        { provider: "outlook", auth_method: "oauth" },
    ])("hides it for $provider / $auth_method", (over) => {
        render(<Page box={mailbox(over)} />);
        expect(screen.queryByText("Renew Google access")).not.toBeInTheDocument();
        expect(reauthButton()).not.toBeInTheDocument();
        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        expect(screen.queryByText("Renew Google access")).not.toBeInTheDocument();
        expect(reauthButton()).not.toBeInTheDocument();
    });

    it("keeps the credential-error button and the settings action", () => {
        accountStatus.mockReturnValue({
            data: {
                errors: [{
                    id: "err-1",
                    error_code: "GOOGLE_AUTHENTICATION_FAILED",
                    severity: "CRITICAL",
                    title: "Google sign-in failed",
                    message: "The stored token was rejected.",
                    created_at: new Date(),
                }],
            },
            isPending: false,
            isError: false,
        });
        render(<Page />);
        expect(screen.getByText("Google sign-in failed")).toBeInTheDocument();
        expect(screen.queryByText("Renew Google access")).not.toBeInTheDocument();
        expect(reauthButton()).toBeInTheDocument();

        fireEvent.click(screen.getByRole("button", { name: "Settings" }));
        expect(screen.getByText("Renew Google access")).toBeInTheDocument();
        expect(reauthButton()).toBeInTheDocument();
    });

    it("runs the existing reauth flow", async () => {
        reauthEmailOAuth.mockResolvedValue({ url: "https://accounts.google.com/o/oauth2", state: "state-1" });
        authorizeEmailInPopup.mockImplementation(async (start: () => Promise<{ url: string; state: string }>) => {
            const begun = await start();
            return { code: "auth-code", state: begun.state };
        });
        onboardOAuthFinish.mockResolvedValue(mailbox());

        render(<Page />);
        fireEvent.click(reauthButton()!);

        await waitFor(() => expect(onboardOAuthFinish).toHaveBeenCalledWith("auth-code", "state-1"));
        expect(reauthEmailOAuth).toHaveBeenCalledWith("mbx");
        expect(authorizeEmailInPopup).toHaveBeenCalledOnce();
    });
});
