import { definePlugin } from '../app/plugin';
import type { World } from '../ecs/world';

export class Time {
  elapsed = 0;
  delta = 0;
  frameCount = 0;

  private lastTime = 0;

  update(now: number = performance.now() / 1000): void {
    if (this.lastTime === 0) {
      this.lastTime = now;
    }

    this.delta = now - this.lastTime;
    this.elapsed += this.delta;
    this.lastTime = now;
    this.frameCount++;
  }
}

function timeUpdateSystem(world: World): void {
  world.getResource(Time)?.update();
}

export const TimePlugin = definePlugin({
  name: 'Time',
  build(app) {
    app.insertResource(new Time());
    app.addSystem('First', {
      id: 'time.update',
      run: timeUpdateSystem
    });
  }
});
