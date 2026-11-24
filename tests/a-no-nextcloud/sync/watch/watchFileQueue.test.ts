import { WatchFileQueue } from '../../../../src/sync/watch/WatchFileQueue';
import { LocalCreationGrace } from '../../../../src/sync/watch/LocalCreationGrace';

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

  it('keeps a newly created folder and its note behind the same deadline after a rename', () => {
    const dispatch = jest.fn();
    const grace = new LocalCreationGrace(() => 10000);
    const queue = new WatchFileQueue(() => 2000, () => true, dispatch, path => grace.readyAt(path));
    grace.add('Untitled', true);
    grace.add('Untitled/Untitled.md', false);
    queue.add('Untitled/Untitled.md');
    jest.advanceTimersByTime(2000);
    expect(grace.rename('Untitled', 'Project', true)).toBe(true);
    queue.rebaseFolder('Untitled', 'Project');
    expect(grace.rename('Project/Untitled.md', 'Project/Project.md', false)).toBe(true);
    expect(queue.take('Project/Untitled.md')).toBe(true);
    queue.add('Project/Project.md');
    jest.advanceTimersByTime(7999);
    expect(dispatch).not.toHaveBeenCalled();
    jest.advanceTimersByTime(1);
    expect(dispatch).toHaveBeenCalledWith(['Project/Project.md']);
  });

  it('flushes an existing edit before Android suspension while keeping a fresh note queued', () => {
    const dispatch = jest.fn();
    const grace = new LocalCreationGrace(() => 10000);
    let visible = true;
    const queue = new WatchFileQueue(() => 2000, () => visible, dispatch, path => grace.readyAt(path));
    grace.add('New.md', false);
    queue.add('New.md');
    queue.add('Existing.md');
    visible = false;
    queue.flushBeforeHide();
    expect(dispatch.mock.calls).toEqual([[['Existing.md']]]);
    jest.advanceTimersByTime(10000);
    expect(dispatch).toHaveBeenCalledTimes(1);
    visible = true;
    queue.refresh();
    jest.advanceTimersByTime(0);
    expect(dispatch.mock.calls).toEqual([[['Existing.md']], [['New.md']]]);
  });
});
