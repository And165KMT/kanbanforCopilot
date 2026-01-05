const os = require('os');

try {
  // When Node runs inside certain sandboxes, os.cpus() can return an empty array.
  const cpus = typeof os.cpus === 'function' ? os.cpus() : [];
  if (!cpus || cpus.length === 0) {
    const fakeCpu = {
      model: 'virtual',
      speed: 1,
      times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
    };
    os.cpus = () => [fakeCpu];
  }
} catch (error) {
  // Fallback to reporting a CPU when querying cpus() throws.
  const fakeCpu = {
    model: 'virtual',
    speed: 1,
    times: { user: 0, nice: 0, sys: 0, idle: 0, irq: 0 }
  };
  os.cpus = () => [fakeCpu];
}
