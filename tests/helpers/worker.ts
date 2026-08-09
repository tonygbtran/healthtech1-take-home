import { EmailSender, Geocoder, tick as workerTick, WorkerConfig, WorkerDeps } from "../../src/services/worker";

export const alwaysSucceedGeocoder: Geocoder = {
	lookupPostcode: async () => ({ statusCode: 200, body: { longitude: 50.05, latitude: -5.05 } }),
};

export const alwaysSucceedEmail: EmailSender = {
	sendEmail: async () => ({ statusCode: 200, body: undefined }),
};

export const EMAIL_RECIPIENT = "happyforms@bots.com";

// tick() with the email pieces defaulted, for tests that exercise the form
// pipeline only; outbox behaviour is covered in outbox.test.ts.
export const tickForms = (
	deps: Omit<WorkerDeps, "emailSender">,
	config: Omit<WorkerConfig, "emailRecipient">,
	now?: () => Date,
): Promise<void> =>
	workerTick({ ...deps, emailSender: alwaysSucceedEmail }, { ...config, emailRecipient: EMAIL_RECIPIENT }, now);
