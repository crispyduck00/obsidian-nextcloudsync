import { WatchFileQueue } from '../../../../src/sync/watch/WatchFileQueue';

describe('Watch file deadlines', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('gives each edit its own quiet period', () => {
    const dispatch = jest.fn();
    const queue = new WatchFileQueue(() => 2000, () => true, dispatch);
    queue.add('First.md');
    jest.advanceTimersByTime(1200);
    queue.add('Second.md');
    jest.advanceTimersByTime(800);
    expect(dispatch.mock.calls).toEqual([[['First.md']]]);
    jest.advanceTimersByTime(1200);
    expect(dispatch.mock.calls).toEqual([[['First.md']], [['Second.md']]]);
  });

  it('re-arms queued work against its original edit time when the preference changes', () => {
    let delay = 2000;
    const dispatch = jest.fn();
    const queue = new WatchFileQueue(() => delay, () => true, dispatch);
    queue.add('Note.md');
    jest.advanceTimersByTime(1000);
    delay = 5000;
    queue.refresh();
    jest.advanceTimersByTime(3999);
    expect(dispatch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(dispatch).toHaveBeenCalledWith(['Note.md']);
  });

  it('moves queued folder children to their final paths without resetting their edit time', () => {
    const dispatch = jest.fn();
    const queue = new WatchFileQueue(() => 2000, () => true, dispatch);
    queue.add('Draft/Note.md');
    queue.add('Drafting/Other.md');
    jest.advanceTimersByTime(300);
    queue.rebaseFolder('Draft', 'Project');
    jest.advanceTimersByTime(1700);
    expect(dispatch).toHaveBeenCalledWith(['Drafting/Other.md', 'Project/Note.md']);
  });

});
