/* eslint-disable @typescript-eslint/ban-ts-comment */
/* eslint-disable @typescript-eslint/no-unsafe-argument */
/*
 Copyright (c) 2024 Xiamen Yaji Software Co., Ltd.

 https://www.cocos.com/

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated documentation files (the "Software"), to deal
 in the Software without restriction, including without limitation the rights to
 use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 of the Software, and to permit persons to whom the Software is furnished to do so,
 subject to the following conditions:

 The above copyright notice and this permission notice shall be included in
 all copies or substantial portions of the Software.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
*/
import { EDITOR_NOT_IN_PREVIEW, JSB, TEST } from 'internal:constants';

import { IPhysicsWorld } from '../spec/i-physics-world';
import { IVec2Like, Vec3, Quat, Vec2, toDegree, Rect, CCObject, js, errorID } from '../../core';
import { PHYSICS_2D_PTM_RATIO, ERaycast2DType, ERigidBody2DType } from '../framework/physics-types';
// import { Canvas } from '../../2d/framework';
import type { Graphics } from '../../2d/components/graphics';

import { b2RigidBody2D } from './rigid-body';
import { PhysicsContactListener } from './platform/physics-contact-listener';
import { PhysicsAABBQueryCallback } from './platform/physics-aabb-query-callback';
import { PhysicsRayCastCallback } from './platform/physics-ray-cast-callback';
import { PhysicsContact, b2ContactExtends } from './physics-contact';
import { Contact2DType, Collider2D, RaycastResult2D } from '../framework';
import { b2Shape2D } from './shapes/shape-2d';
import { PhysicsDebugDraw } from './platform/physics-debug-draw';
import { Node, find, Layers } from '../../scene-graph';
import { director } from '../../game';
import { b2EmptyInstance } from './empty-for-editor';

let _tempFloatArray: Float32Array;

if (!JSB) {
    (globalThis as any).b2jsb = b2EmptyInstance;
} else {
    //@ts-ignore
    _tempFloatArray = new Float32Array(jsb.createExternalArrayBuffer(5 * 4)); // 5 floats is enough for box2d jsb.
    //@ts-ignore
    b2jsb._tempFloatArray = _tempFloatArray; // For other ts file in box2d-jsb module to access this arraybuffer.
    b2jsb._setTempFloatArray(_tempFloatArray.buffer);
}

const tempVec3 = new Vec3();
const tempVec2_1 = new Vec2();
const tempVec2_2 = new Vec2();

const temoBodyDef = new b2jsb.BodyDef();
const tempB2AABB = new b2jsb.AABB();

const testResults: Collider2D[] = [];

// namespace b2 {
/// Color for debug drawing. Each value has the range [0,1].
class Color {
    constructor (rIn?: number, gIn?: number, bIn?: number, aIn?: number) {
        this.r = rIn ?? 0;
        this.g = gIn ?? 0;
        this.b = bIn ?? 0;
        this.a = aIn ?? 1.0;
    }

    Set (rIn?: number, gIn?: number, bIn?: number, aIn?: number): void {
        this.r = rIn ?? 0;
        this.g = gIn ?? 0;
        this.b = bIn ?? 0;
        this.a = aIn ?? 1.0;
    }

    declare r: number;
    declare g: number;
    declare b: number;
    declare a: number;
}

// }
b2jsb.Color = Color;

export class b2PhysicsWorld implements IPhysicsWorld {
    protected _world: b2jsb.World;
    protected _bodies: b2RigidBody2D[] = [];
    protected _animatedBodies: b2RigidBody2D[] = [];
    protected _rotationAxis: Vec3 = new Vec3();
    protected _physicsGroundBody: b2jsb.Body;

    protected _contactListener: PhysicsContactListener;
    protected _aabbQueryCallback: PhysicsAABBQueryCallback;
    protected _raycastQueryCallback: PhysicsRayCastCallback;

    get impl (): b2jsb.World {
        return this._world;
    }

    get groundBodyImpl (): b2jsb.Body {
        return this._physicsGroundBody;
    }

    constructor () {
        this._world = new b2jsb.World(new b2jsb.Vec2(0, -10));
        const tempBodyDef = new b2jsb.BodyDef();
        //tempBodyDef.position.Set(480 / PHYSICS_2D_PTM_RATIO, 320 / PHYSICS_2D_PTM_RATIO);//temporary
        this._physicsGroundBody = this._world.CreateBody(tempBodyDef);
        const listener = new PhysicsContactListener();
        listener.initWithThis(listener);
        listener.setBeginContact(this._onBeginContact);
        listener.setEndContact(this._onEndContact);
        listener.setPreSolve(this._onPreSolve);
        listener.setPostSolve(this._onPostSolve);
        this._world.SetContactListener(listener);

        this._contactListener = listener;

        this._aabbQueryCallback = new PhysicsAABBQueryCallback();
        this._raycastQueryCallback = new PhysicsRayCastCallback();
    }

    _debugGraphics: Graphics | null = null;
    _b2DebugDrawer: b2jsb.Draw | null = null;

    _debugDrawFlags = 0;
    get debugDrawFlags (): number {
        return this._debugDrawFlags;
    }
    set debugDrawFlags (v) {
        if (EDITOR_NOT_IN_PREVIEW) return;

        if (!v) {
            if (this._debugGraphics) {
                this._debugGraphics.node.parent = null;
            }
        }

        this._debugDrawFlags = v;
    }

    _checkDebugDrawValid (): void {
        if (EDITOR_NOT_IN_PREVIEW) return;
        if (!this._debugGraphics || !this._debugGraphics.isValid) {
            let canvas = find('Canvas');
            if (!canvas) {
                const scene = director.getScene();
                if (!scene) {
                    return;
                }

                canvas = new Node('Canvas');
                canvas.addComponent('cc.Canvas');
                canvas.parent = scene;
            }

            let node: Node | null = new Node('PHYSICS_2D_DEBUG_DRAW');
            // node.zIndex = cc.macro.MAX_ZINDEX;
            node.hideFlags |= CCObject.Flags.DontSave;
            node.parent = canvas;
            node.worldPosition = Vec3.ZERO;
            node.layer = Layers.Enum.UI_2D;

            try {
                this._debugGraphics = node.addComponent<Graphics>('cc.Graphics');
                this._debugGraphics.lineWidth = 3;
                // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
                const debugDraw = new PhysicsDebugDraw(this._debugGraphics);
                debugDraw.initWithThis(debugDraw);
                this._b2DebugDrawer = debugDraw;
                this._world.SetDebugDraw(debugDraw);
                const parent = this._debugGraphics.node.parent!;
                this._debugGraphics.node.setSiblingIndex(parent.children.length - 1);
            } catch (e: any) {
                errorID(4501, e.message as string);
                node.destroy();
                node = null;
            }
        }

        if (this._b2DebugDrawer) {
            this._b2DebugDrawer.SetFlags(this.debugDrawFlags);
        }
    }

    setGravity (v: IVec2Like): void {
        this._world.SetGravity(v as b2jsb.Vec2);
    }

    setAllowSleep (v: boolean): void {
        this._world.SetAllowSleeping(true);
    }

    step (deltaTime: number, velocityIterations = 10, positionIterations = 10): void {
        const animatedBodies = this._animatedBodies;
        for (let i = 0, l = animatedBodies.length; i < l; i++) {
            animatedBodies[i].animate(deltaTime);
        }
        this._world.Step(deltaTime, velocityIterations, positionIterations);
    }

    raycast (p1: Vec2, p2: Vec2, type: ERaycast2DType, mask: number): RaycastResult2D[] {
        if (p1.equals(p2)) {
            return [];
        }

        type = type || ERaycast2DType.Closest;

        tempVec2_1.x = p1.x / PHYSICS_2D_PTM_RATIO;
        tempVec2_1.y = p1.y / PHYSICS_2D_PTM_RATIO;
        tempVec2_2.x = p2.x / PHYSICS_2D_PTM_RATIO;
        tempVec2_2.y = p2.y / PHYSICS_2D_PTM_RATIO;

        const callback = this._raycastQueryCallback;
        callback.init(type, mask);
        this._world.RayCast(callback, tempVec2_1, tempVec2_2);

        const fixtures = callback.getFixtures() as b2jsb.Fixture[];
        if (fixtures.length > 0) {
            const points = callback.getPoints();
            const normals = callback.getNormals();
            const fractions = callback.getFractions();

            const results: RaycastResult2D[] = [];
            for (let i = 0, l = fixtures.length; i < l; i++) {
                const fixture = fixtures[i];
                const shape = fixture.m_userData as b2Shape2D;
                const collider = shape.collider;

                if (type === ERaycast2DType.AllClosest) {
                    let result;
                    for (let j = 0; j < results.length; j++) {
                        if (results[j].collider === collider) {
                            result = results[j];
                        }
                    }

                    if (result) {
                        if (fractions[i] < result.fraction) {
                            result.fixtureIndex = shape.getFixtureIndex(fixture);
                            result.point.x = points[i].x * PHYSICS_2D_PTM_RATIO;
                            result.point.y = points[i].y * PHYSICS_2D_PTM_RATIO;
                            result.normal.x = normals[i].x;
                            result.normal.y = normals[i].y;
                            result.fraction = fractions[i];
                        }
                        continue;
                    }
                }

                results.push({
                    collider,
                    fixtureIndex: shape.getFixtureIndex(fixture),
                    point: new Vec2(points[i].x * PHYSICS_2D_PTM_RATIO, points[i].y * PHYSICS_2D_PTM_RATIO),
                    normal: new Vec2(normals[i].x, normals[i].y),
                    fraction: fractions[i],
                });
            }

            return results;
        }

        return [];
    }

    syncPhysicsToScene (): void {
        const bodies = this._bodies;
        for (let i = 0, l = bodies.length; i < l; i++) {
            const body = bodies[i];
            const bodyComp = body.rigidBody;
            if (bodyComp.type === ERigidBody2DType.Animated) {
                body.resetVelocity();
                continue;
            }

            const node = bodyComp.node;
            const b2body = body.impl;

            // position
            b2body!._GetTransformJSB();
            // The _GetTransformJSB which we bind it manually is for optimizing the communication between JS and CPP.
            // It will fill the _tempFloatArray with the first three elements.
            // _tempFloatArray[0]: position's x
            // _tempFloatArray[1]: position's y
            // _tempFloatArray[2]: angle
            tempVec3.x = _tempFloatArray[0] * PHYSICS_2D_PTM_RATIO;
            tempVec3.y = _tempFloatArray[1] * PHYSICS_2D_PTM_RATIO;
            tempVec3.z = 0;

            // rotation
            const angle = toDegree(_tempFloatArray[2]);

            //@ts-ignore
            node.set2DTransform(tempVec3.x, tempVec3.y, angle);
        }
    }
    syncSceneToPhysics (): void {
        const bodies = this._bodies;
        for (let i = 0; i < bodies.length; i++) {
            bodies[i].syncSceneToPhysics();
        }
    }

    addBody (body: b2RigidBody2D): void {
        const bodies = this._bodies;
        if (bodies.includes(body)) {
            return;
        }

        const bodyDef = temoBodyDef;

        const comp = body.rigidBody;

        bodyDef.allowSleep = comp.allowSleep;
        bodyDef.gravityScale = comp.gravityScale;
        bodyDef.linearDamping = comp.linearDamping;
        bodyDef.angularDamping = comp.angularDamping;

        bodyDef.fixedRotation = comp.fixedRotation;
        bodyDef.bullet = comp.bullet;

        const node = comp.node;
        const pos = node.worldPosition;
        //@ts-ignore
        bodyDef.position = { x: pos.x / PHYSICS_2D_PTM_RATIO, y: pos.y / PHYSICS_2D_PTM_RATIO };

        tempVec3.z = Quat.getAxisAngle(this._rotationAxis, node.worldRotation);
        if (this._rotationAxis.z < 0.0) {
            tempVec3.z = Math.PI * 2 - tempVec3.z;
        }
        bodyDef.angle = tempVec3.z;

        bodyDef.awake = comp.awakeOnLoad;

        if (comp.type === ERigidBody2DType.Animated) {
            bodyDef.type = ERigidBody2DType.Kinematic as number;

            this._animatedBodies.push(body);
            const bodyPos = bodyDef.position;
            body._animatedPos.set(bodyPos.x, bodyPos.y);
            body._animatedAngle = bodyDef.angle;
        } else {
            bodyDef.type = comp.type as number;
        }

        // read private property
        const compPrivate = comp as any;
        const linearVelocity = compPrivate._linearVelocity as Vec2;
        //@ts-ignore
        bodyDef.linearVelocity = { x: linearVelocity.x, y: linearVelocity.y };

        bodyDef.angularVelocity = compPrivate._angularVelocity;

        const b2Body = this._world.CreateBody(bodyDef);
        b2Body.m_userData = body;
        body._imp = b2Body;

        this._bodies.push(body);
    }

    removeBody (body: b2RigidBody2D): void {
        if (!this._bodies.includes(body)) {
            return;
        }
        if (body.impl) {
            body.impl.m_userData = null;
            this._world.DestroyBody(body.impl);
            body._imp = null;
        }
        js.array.remove(this._bodies, body);

        const comp = body.rigidBody;
        if (comp.type === ERigidBody2DType.Animated) {
            js.array.remove(this._animatedBodies, body);
        }
    }

    registerContactFixture (fixture: b2jsb.Fixture): void {
        this._contactListener.registerContactFixture(fixture);
    }
    unregisterContactFixture (fixture: b2jsb.Fixture): void {
        this._contactListener.unregisterContactFixture(fixture);
    }

    testPoint (point: Vec2): readonly Collider2D[] {
        const x = tempVec2_1.x = point.x / PHYSICS_2D_PTM_RATIO;
        const y = tempVec2_1.y = point.y / PHYSICS_2D_PTM_RATIO;

        const d = 0.2 / PHYSICS_2D_PTM_RATIO;
        tempB2AABB.lowerBound = { x: x - d, y: y - d };
        tempB2AABB.upperBound = { x: x + d, y: y + d };

        const callback = this._aabbQueryCallback;
        callback.init(tempVec2_1);
        this._world.QueryAABB(callback, tempB2AABB);

        const fixtures = callback.getFixtures();
        testResults.length = 0;
        for (let i = 0; i < fixtures.length; i++) {
            const collider = (fixtures[i].m_userData as b2Shape2D).collider;
            if (!testResults.includes(collider)) {
                testResults.push(collider);
            }
        }
        return testResults;
    }

    testAABB (rect: Rect): readonly Collider2D[] {
        tempB2AABB.lowerBound = { x: rect.xMin / PHYSICS_2D_PTM_RATIO, y: rect.yMin / PHYSICS_2D_PTM_RATIO };
        tempB2AABB.upperBound = { x: rect.xMax / PHYSICS_2D_PTM_RATIO, y: rect.yMax / PHYSICS_2D_PTM_RATIO };

        const callback = this._aabbQueryCallback;
        callback.init();
        this._world.QueryAABB(callback, tempB2AABB);

        const fixtures = callback.getFixtures();
        testResults.length = 0;
        for (let i = 0; i < fixtures.length; i++) {
            const collider = (fixtures[i].m_userData as b2Shape2D).collider;
            if (!testResults.includes(collider)) {
                testResults.push(collider);
            }
        }
        return testResults;
    }

    drawDebug (): void {
        if (TEST) return;
        this._checkDebugDrawValid();

        if (!this._debugGraphics) {
            return;
        }
        this._debugGraphics.clear();
        this._world.DrawDebugData();
    }

    _onBeginContact (b2contact: b2ContactExtends): void {
        const c = PhysicsContact.get(b2contact);
        c.emit(Contact2DType.BEGIN_CONTACT);
    }

    _onEndContact (b2contact: b2ContactExtends): void {
        const c = b2contact.m_userData as PhysicsContact;
        if (!c) {
            return;
        }
        c.emit(Contact2DType.END_CONTACT);

        PhysicsContact.put(b2contact);
    }

    _onPreSolve (b2contact: b2ContactExtends): void {
        const c = b2contact.m_userData as PhysicsContact;
        if (!c) {
            return;
        }

        c.emit(Contact2DType.PRE_SOLVE);
    }

    _onPostSolve (b2contact: b2ContactExtends, impulse: b2jsb.ContactImpulse): void {
        const c: PhysicsContact = b2contact.m_userData as PhysicsContact;
        if (!c) {
            return;
        }

        // impulse only survive during post sole callback
        c._setImpulse(impulse);
        c.emit(Contact2DType.POST_SOLVE);
        c._setImpulse(null);
    }
}
