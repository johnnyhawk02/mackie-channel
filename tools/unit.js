const core = require('../mackie-channel-core.js');
const { Netlist, Circuit, MODELS } = core;
const T = 1 / 88200;
// 1) inverting amp gain -2
let n = new Netlist(); n.V('in', 'I'); n.R('I', 'N', 10000); n.R('O', 'N', 20000); n.U('U', '0', 'N', 'O', 'NJM4560', 16, -16); n.out('o', 'O');
let c = new Circuit(n, T); c.settle(new Float64Array([1]), T); console.log('inv amp in=1 ->', c.y[0], 'its', c.step(new Float64Array([1])));
c.settle(new Float64Array([10]), T); console.log('inv amp in=10 ->', c.y[0]);
// 2) PNP with emitter resistor
n = new Netlist(); n.V('vcc', 'V'); n.R('V', 'E', 1000); n.Q('C', '0', 'E', MODELS.MMBT4403); n.R('C', 'M', 1000); n.V('vee', 'M'); n.out('e', 'E'); n.out('c', 'C');
c = new Circuit(n, T); c.settle(new Float64Array([5, -5]), T); console.log('pnp E,C', c.y, '(expect E~0.65, C~-0.65)');
