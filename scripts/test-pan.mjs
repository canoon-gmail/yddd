import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';

const cam = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
cam.position.set(0, 0, 10);

class FakeCanvas {
  listeners = {};
  style = {};
  ownerDocument = {
    addEventListener(k, fn) { this[k] = fn; },
    removeEventListener() {}
  };
  addEventListener(k, fn, opt) { (this.listeners[k] = this.listeners[k] || []).push({ fn, opt }); }
  removeEventListener() {}
  setPointerCapture() {}
  releasePointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 800, height: 600 }; }
  clientHeight = 600;
  clientWidth = 800;
}

const canvas = new FakeCanvas();
const controls = new OrbitControls(cam, canvas);

// Case 1: mouseButtons.LEFT = THREE.MOUSE.PAN
controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
const pd = canvas.listeners['pointerdown'][0].fn;
pd({ button: 0, pointerType: 'mouse', pointerId: 1, shiftKey: true, clientX: 100, clientY: 100 });
console.log('Case 1 state (mouseButtons.LEFT = PAN, shiftKey = true):', controls.state, '(0: NONE, 1: ROTATE, 2: DOLLY, 3: PAN)');

// Case 2: mouseButtons.LEFT = THREE.MOUSE.ROTATE
controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
canvas.ownerDocument.pointerup({ pointerType: 'mouse', pointerId: 1 });
pd({ button: 0, pointerType: 'mouse', pointerId: 1, shiftKey: true, clientX: 100, clientY: 100 });
console.log('Case 2 state (mouseButtons.LEFT = ROTATE, shiftKey = true):', controls.state, '(0: NONE, 1: ROTATE, 2: DOLLY, 3: PAN)');
