"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const BookingController_1 = require("../controllers/BookingController");
const GetAvailableAppointmentsUseCase_1 = require("../../application/use-cases/project/GetAvailableAppointmentsUseCase");
const BookAppointmentUseCase_1 = require("../../application/use-cases/project/BookAppointmentUseCase");
const AppointmentRepository_1 = require("../../infrastructure/repositories/AppointmentRepository");
const ProjectRepository_1 = require("../../infrastructure/repositories/ProjectRepository");
const AuthMiddleware_1 = require("../middlewares/AuthMiddleware");
const RbacMiddleware_1 = require("../middlewares/RbacMiddleware");
const router = (0, express_1.Router)();
const appointmentRepo = new AppointmentRepository_1.AppointmentRepository();
const projectRepo = new ProjectRepository_1.ProjectRepository();
const bookingController = new BookingController_1.BookingController(new GetAvailableAppointmentsUseCase_1.GetAvailableAppointmentsUseCase(appointmentRepo, projectRepo), new BookAppointmentUseCase_1.BookAppointmentUseCase(appointmentRepo, projectRepo), appointmentRepo);
router.get('/slots', (req, res) => bookingController.getAvailableSlots(req, res));
router.post('/book', (req, res) => bookingController.bookSlot(req, res));
router.post('/slots', AuthMiddleware_1.requireAuth, (0, RbacMiddleware_1.requirePermission)('projects.bookings.manage'), (req, res) => bookingController.createAdminSlots(req, res));
exports.default = router;
//# sourceMappingURL=booking.routes.js.map