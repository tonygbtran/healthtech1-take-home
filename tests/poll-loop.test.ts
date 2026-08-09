import { startPollLoop } from "../src/services/worker";

describe("startPollLoop", () => {
	beforeEach(() => {
		jest.useFakeTimers();
	});

	afterEach(() => {
		jest.useRealTimers();
	});

	it("runs the tick on the configured interval until stopped", async () => {
		const runTick = jest.fn().mockResolvedValue(undefined);
		const stop = startPollLoop(runTick, 1000);

		expect(runTick).not.toHaveBeenCalled();
		await jest.advanceTimersByTimeAsync(1000);
		expect(runTick).toHaveBeenCalledTimes(1);
		await jest.advanceTimersByTimeAsync(2000);
		expect(runTick).toHaveBeenCalledTimes(3);

		stop();
		await jest.advanceTimersByTimeAsync(5000);
		expect(runTick).toHaveBeenCalledTimes(3);
	});

	it("keeps polling when a tick rejects", async () => {
		const runTick = jest.fn().mockRejectedValue(new Error("boom"));
		const stop = startPollLoop(runTick, 1000);

		await jest.advanceTimersByTimeAsync(2000);
		expect(runTick).toHaveBeenCalledTimes(2);
		stop();
	});
});
